import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, AppStrategy } from '@wix/sdk';
import { contacts } from '@wix/crm';
import { submissions } from '@wix/forms';
import { appInstances } from '@wix/app-management';

export type WixEventType = 'contact_created' | 'contact_updated' | 'contact_deleted' | 'submission_created' | 'app_removed';

/** Normalised Wix webhook event (no entity payload kept: handlers re-read the source of truth). */
export interface WixEvent {
  type: WixEventType;
  instanceId: string;
  entityId: string;
  eventId?: string;
  /** Who made the change. identityType "APP" + our appId => our own write (origin tag). */
  identity?: { identityType?: string; appId?: string | null };
}

export interface WixEventParser {
  /** Verifies the webhook JWT and returns the events it carries. Throws when the signature is invalid. */
  parse(rawBody: string): Promise<WixEvent[]>;
}

/**
 * Wix sends webhooks as a JWT signed with the app's key pair; the SDK verifies it
 * with the app's public key and converts the payload into typed envelopes.
 */
export class SdkWixEventParser implements WixEventParser {
  private sink = new AsyncLocalStorage<WixEvent[]>();
  private client;

  constructor(appId: string, publicKey: string) {
    this.client = createClient({ auth: AppStrategy({ appId, publicKey }), modules: { contacts, submissions, appInstances } });
    const push = (e: WixEvent): void => void this.sink.getStore()?.push(e);
    const identity = (m: { identity?: unknown }) => m.identity as WixEvent['identity'];

    this.client.contacts.onContactCreated((e) =>
      push({ type: 'contact_created', instanceId: e.metadata.instanceId!, entityId: e.entity._id!, eventId: e.metadata._id, identity: identity(e.metadata) }),
    );
    this.client.contacts.onContactUpdated((e) =>
      push({ type: 'contact_updated', instanceId: e.metadata.instanceId!, entityId: e.entity._id!, eventId: e.metadata._id, identity: identity(e.metadata) }),
    );
    this.client.contacts.onContactDeleted((e) =>
      push({ type: 'contact_deleted', instanceId: e.metadata.instanceId!, entityId: e.metadata.entityId!, eventId: e.metadata._id, identity: identity(e.metadata) }),
    );
    this.client.submissions.onSubmissionCreated((e) =>
      push({ type: 'submission_created', instanceId: e.metadata.instanceId!, entityId: e.entity._id!, eventId: e.metadata._id }),
    );
    this.client.appInstances.onAppInstanceRemoved((e) => push({ type: 'app_removed', instanceId: e.metadata.instanceId!, entityId: e.metadata.instanceId! }));
  }

  async parse(rawBody: string): Promise<WixEvent[]> {
    const events: WixEvent[] = [];
    await this.sink.run(events, () => this.client.webhooks.process(rawBody));
    return events;
  }
}
