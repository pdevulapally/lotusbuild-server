import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

import { authenticatedUser } from '../auth/plugin.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import { cached } from '../support/cache.ts';
import type { UserRepository } from '../users/repository.ts';
import type { BillingRepository } from './repository.ts';
import { ensurePriceId, readSubscription, throughStripe } from './stripe.ts';

export interface BillingUrls {
  readonly checkoutSuccess: URL;
  readonly checkoutCancel: URL;
  readonly portalReturn: URL;
}

/**
 * Events that change what a customer is entitled to.
 *
 * Deliberately short. Stripe sends dozens of event types and subscribing to
 * everything means handling payloads whose meaning we never decided on;
 * anything not listed is acknowledged and ignored, which is what stops Stripe
 * retrying an event we were never going to act on.
 */
const subscriptionEvents = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const deletionEvents = new Set(['customer.subscription.deleted']);

export function registerBillingRoutes(
  app: FastifyInstance,
  deps: {
    readonly stripe: Stripe;
    readonly billing: BillingRepository;
    readonly users: UserRepository;
    readonly configuration: ConfigurationStore;
    readonly webhookSecret: string;
    readonly urls: BillingUrls;
    /** How long the public plan catalogue is held before Stripe is asked again. */
    readonly catalogueTtlMs: number;
  },
): void {
  const { stripe, billing, users, configuration, urls } = deps;

  /** The Stripe customer for this account, made once and remembered. */
  const customerFor = async (uid: string, onError: (error: Error) => void): Promise<string> => {
    const existing = await billing.customerIdFor(uid);
    if (existing !== undefined) {
      return existing;
    }
    const stored = await users.read(uid);
    const customer = await throughStripe(
      'open an account',
      () =>
        stripe.customers.create(
          {
            email: stored.email,
            // So a customer opened in Stripe's dashboard says who it is.
            metadata: { uid },
          },
          // Stripe's own idempotency: two clicks on Subscribe must not create
          // two customers, and the uid is the natural key for "the customer for
          // this account".
          { idempotencyKey: `customer:${uid}` },
        ),
      onError,
    );
    await billing.linkCustomer(uid, customer.id);
    return customer.id;
  };

  /**
   * The plan catalogue, as the pricing page needs it.
   *
   * Unauthenticated, because the pricing page renders before anyone signs in.
   * The alternative is the marketing copy keeping its own copy of the numbers,
   * which drifts from what the plans actually grant and from what Stripe
   * actually charges — and a page promising more than the entitlements allow is
   * a refund, not a typo.
   *
   * Rows are derived from the registry's own capability and meter definitions,
   * so a capability added to configuration is advertised without a deploy and
   * one removed stops being advertised. Every field is named rather than spread:
   * a plan document also carries its Stripe price id, its rate-limit budgets and
   * its sandbox instructions, none of which are the public's business.
   *
   * Reads no further than configuration. The amount lives in the plan document
   * and Stripe is a projection of it, so the page and the checkout cannot
   * disagree and rendering a price costs no API call.
   */
  const catalogue = cached(deps.catalogueTtlMs, async () => {
    const { registry, plans } = await configuration.get();

    return (
      [...plans.values()]
        .filter((plan) => plan.status === 'ACTIVE')
        .sort((left, right) => left.rank - right.rank)
        .map((plan) => ({
          key: plan.key,
          name: plan.name,
          rank: plan.rank,
          price: plan.price,
          capabilities: [...plan.entitlements].flatMap(([key, entitlement]) => {
            const definition = registry.capabilities.get(key);
            if (definition === undefined) {
              return [];
            }
            return [
              { key, label: definition.label, kind: entitlement.kind, value: entitlement.value },
            ];
          }),
          allowances: [...plan.meterLimits].flatMap(([key, limit]) => {
            const meter = registry.meters.get(key);
            if (meter === undefined) {
              return [];
            }
            return [
              {
                key,
                label: meter.label,
                unit: meter.unit,
                included: limit.includedAllowance,
                limit: limit.hardLimit,
              },
            ];
          }),
        }))
    );
  });

  app.get(
    '/plans',
    {
      config: {
        // Keyed by address, like the webhook: there is no account to key on
        // before sign-in. Serving from the TTL cache, so this bounds CPU rather
        // than spend.
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async () => ({ plans: await catalogue.get() }),
  );

  app.post<{ Body: { planKey: string } }>(
    '/billing/checkout',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: {
        body: {
          type: 'object',
          required: ['planKey'],
          additionalProperties: false,
          properties: { planKey: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const { plans } = await configuration.get();
      const purchasable = [...plans.values()].filter((plan) => plan.price !== undefined);

      const plan = plans.get(request.body.planKey);
      // Reported the same way whether the plan does not exist, is retired, or
      // is not for sale: a caller probing plan keys learns nothing either way.
      if (plan === undefined || plan.status !== 'ACTIVE' || plan.price === undefined) {
        throw new AppError({
          code: 'billing/plan-not-purchasable',
          statusCode: 404,
          message: 'No such plan is available to buy.',
          details: {
            available: purchasable
              .filter((candidate) => candidate.status === 'ACTIVE')
              .map((candidate) => candidate.key),
          },
        });
      }

      const onError = (error: Error): void => {
        request.log.error({ err: error, uid: user.uid }, 'stripe rejected a billing call');
      };
      const customer = await customerFor(user.uid, onError);
      // Published from the plan document if Stripe has not seen this amount yet,
      // so a price change is a configuration edit and nothing else.
      const priceId = await ensurePriceId(stripe, plan, onError);
      const session = await throughStripe(
        'start checkout',
        () =>
          stripe.checkout.sessions.create({
            mode: 'subscription',
            customer,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: urls.checkoutSuccess.toString(),
            cancel_url: urls.checkoutCancel.toString(),
            client_reference_id: user.uid,
            // Carried onto the subscription itself, so an event about it can be
            // traced back to an account even from Stripe's dashboard.
            subscription_data: { metadata: { uid: user.uid, planKey: plan.key } },
          }),
        onError,
      );

      if (session.url === null) {
        throw new AppError({
          code: 'billing/checkout-unavailable',
          statusCode: 502,
          message: 'Stripe did not return a checkout page.',
        });
      }
      return { url: session.url };
    },
  );

  /**
   * Changing, cancelling and paying for a subscription all happen in Stripe's
   * own portal. Rebuilding that here would mean handling cards, and the only
   * safe amount of card handling is none.
   */
  app.post(
    '/billing/portal',
    { preHandler: [app.requireAuth, app.enforceRateLimit('write')] },
    async (request) => {
      const user = authenticatedUser(request);
      const customerId = await billing.customerIdFor(user.uid);
      if (customerId === undefined) {
        throw new AppError({
          code: 'billing/no-customer',
          statusCode: 409,
          message: 'This account has never subscribed, so there is nothing to manage.',
        });
      }
      const session = await throughStripe(
        'open the billing portal',
        () =>
          stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: urls.portalReturn.toString(),
          }),
        (error) => {
          request.log.error({ err: error, uid: user.uid }, 'stripe rejected a billing call');
        },
      );
      return { url: session.url };
    },
  );

  /**
   * Stripe's webhook.
   *
   * Unauthenticated by necessity — Stripe has no token of ours — so the
   * signature is the authentication, and it is checked before the body is
   * looked at. Registered inside its own plugin scope with a parser that keeps
   * the raw bytes: the signature covers exactly what was sent, and a body that
   * has been through `JSON.parse` and back can never be verified again.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post(
      '/webhooks/stripe',
      {
        config: {
          // Keyed by address rather than by plan: there is no account yet at
          // this point. Generous, because throttling Stripe's retries would
          // turn a burst into lost subscription changes.
          rateLimit: { max: 300, timeWindow: '1 minute' },
        },
      },
      async (request, reply) => {
        const signature = request.headers['stripe-signature'];
        if (typeof signature !== 'string') {
          throw new AppError({
            code: 'billing/unsigned-webhook',
            statusCode: 400,
            message: 'This endpoint only accepts signed Stripe events.',
          });
        }

        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(
            request.body as Buffer,
            signature,
            deps.webhookSecret,
          );
        } catch (cause) {
          // Logged, never echoed: the reason a signature failed is a detail an
          // attacker would use to work out how close they got.
          request.log.warn({ err: cause }, 'rejected an unverifiable Stripe event');
          throw new AppError({
            code: 'billing/bad-signature',
            statusCode: 400,
            message: 'This event could not be verified.',
          });
        }

        if (!(await billing.claimEvent(event.id))) {
          // Already handled. Acknowledged so Stripe stops resending it.
          return reply.code(200).send({ received: true, duplicate: true });
        }

        try {
          const handled = await handleEvent(event);
          request.log.info({ eventId: event.id, type: event.type, handled }, 'stripe event');
          return reply.code(200).send({ received: true });
        } catch (error) {
          // The claim is given back so Stripe's next retry is allowed to try
          // again; keeping it would turn one transient failure into a
          // subscription change that is never applied.
          await billing.releaseEvent(event.id);
          throw error;
        }
      },
    );
  });

  /** Returns what was done, for the log. Unknown events are acknowledged. */
  async function handleEvent(event: Stripe.Event): Promise<string> {
    if (!subscriptionEvents.has(event.type) && !deletionEvents.has(event.type)) {
      return 'ignored';
    }

    const subscription = event.data.object as Stripe.Subscription;
    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const uid = await billing.uidForCustomer(customerId);
    if (uid === undefined) {
      // A customer created outside this service, or one whose account is gone.
      // Nothing to apply it to, and no retry will change that.
      return 'unknown-customer';
    }

    if (deletionEvents.has(event.type)) {
      await billing.removeSubscription(uid);
      return 'removed';
    }

    const { plans } = await configuration.get();
    const state = readSubscription(subscription, plans);
    return billing.applySubscription({
      uid,
      state,
      eventCreatedAt: new Date(event.created * 1000),
    });
  }
}
