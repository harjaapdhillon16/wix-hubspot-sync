import { createClient, AppStrategy } from '@wix/sdk';
import { contacts, extendedFields } from '@wix/crm';
import { embeddedScripts } from '@wix/app-management';
import { submissions } from '@wix/forms';
import type { FormSubmissionInput } from '../forms/submissions.js';
import type { WixContact, WixContactInfo } from './fields.js';

/**
 * Everything the sync engine needs from Wix. The production implementation uses the
 * Wix SDK with AppStrategy (app id + secret + instance id => an app-scoped access
 * token for that site); tests and the local mock stack use an in-memory fake.
 */
export interface WixGateway {
  getContact(instanceId: string, id: string): Promise<WixContact | null>;
  findContactByEmail(instanceId: string, email: string): Promise<WixContact | null>;
  createContact(instanceId: string, info: WixContactInfo): Promise<WixContact>;
  updateContact(instanceId: string, id: string, info: WixContactInfo, revision: number): Promise<WixContact>;
  iterateContacts(instanceId: string): AsyncIterable<WixContact>;
  listExtendedFields(instanceId: string): Promise<Array<{ key: string; displayName: string; dataType?: string }>>;
  embedAttributionScript(instanceId: string, parameters: Record<string, string>): Promise<void>;
  getFormSubmission(instanceId: string, submissionId: string): Promise<FormSubmissionInput | null>;
}

export class SdkWixGateway implements WixGateway {
  private clients = new Map<string, ReturnType<SdkWixGateway['makeClient']>>();

  constructor(private appId: string, private appSecret: string) {}

  private makeClient(instanceId: string) {
    return createClient({
      auth: AppStrategy({ appId: this.appId, appSecret: this.appSecret, instanceId }),
      modules: { contacts, extendedFields, embeddedScripts, submissions },
    });
  }

  private client(instanceId: string) {
    let c = this.clients.get(instanceId);
    if (!c) {
      c = this.makeClient(instanceId);
      this.clients.set(instanceId, c);
    }
    return c;
  }

  async getContact(instanceId: string, id: string) {
    try {
      return (await this.client(instanceId).contacts.getContact(id)) as WixContact;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async findContactByEmail(instanceId: string, email: string) {
    const res = await this.client(instanceId).contacts.queryContacts().eq('primaryInfo.email', email).limit(1).find();
    return (res.items[0] as WixContact | undefined) ?? null;
  }

  async createContact(instanceId: string, info: WixContactInfo) {
    const res = await this.client(instanceId).contacts.createContact(info as contacts.ContactInfo, { allowDuplicates: false });
    return res.contact as WixContact;
  }

  async updateContact(instanceId: string, id: string, info: WixContactInfo, revision: number) {
    const res = await this.client(instanceId).contacts.updateContact(id, info as contacts.ContactInfo, revision);
    return res.contact as WixContact;
  }

  async *iterateContacts(instanceId: string) {
    let page = await this.client(instanceId).contacts.queryContacts().limit(100).find();
    for (;;) {
      for (const item of page.items) yield item as WixContact;
      if (!page.hasNext()) break;
      page = await page.next();
    }
  }

  async listExtendedFields(instanceId: string) {
    const res = await this.client(instanceId).extendedFields.listExtendedFields({ paging: { limit: 100 } });
    return (res.fields ?? []).map((f) => ({ key: f.key ?? '', displayName: f.displayName ?? '', dataType: f.dataType }));
  }

  async embedAttributionScript(instanceId: string, parameters: Record<string, string>) {
    await this.client(instanceId).embeddedScripts.embedScript({ parameters });
  }

  async getFormSubmission(instanceId: string, submissionId: string): Promise<FormSubmissionInput | null> {
    try {
      const s = await this.client(instanceId).submissions.getSubmission(submissionId);
      return { id: s._id!, formId: s.formId, contactId: s.contactId, createdDate: s._createdDate, values: s.submissions ?? {} };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { details?: { applicationError?: { code?: string } }; response?: { status?: number }; message?: string };
  return e?.response?.status === 404 || e?.details?.applicationError?.code === 'CONTACT_NOT_FOUND' || /not.?found/i.test(e?.message ?? '');
}
