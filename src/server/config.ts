import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  NODE_ENV: z.string().default('development'),

  // Wix app credentials (Wix Dev Center -> OAuth / Webhooks pages)
  WIX_APP_ID: z.string().min(1),
  WIX_APP_SECRET: z.string().min(1),
  WIX_PUBLIC_KEY: z.string().default(''),

  // HubSpot public app credentials (HubSpot developer account -> app -> Auth)
  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_APP_ID: z.string().default(''),
  // Least privilege: contacts read/write for sync + form capture, schema read/write
  // to list properties for the mapping UI and create the attribution properties.
  HUBSPOT_SCOPES: z
    .string()
    .default('oauth crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write'),
  HUBSPOT_API_BASE: z.string().url().default('https://api.hubapi.com'),
  HUBSPOT_AUTH_BASE: z.string().url().default('https://app.hubspot.com'),

  // Token storage: "gcp" = Google Secret Manager (production), "local" = AES-256-GCM in SQLite (dev)
  SECRET_STORE: z.enum(['gcp', 'local']).default('local'),
  GCP_PROJECT_ID: z.string().default(''),
  SECRET_PREFIX: z.string().default('wix-hubspot'),
  // 32-byte key (base64). Also used as the HMAC key for hashing PII before storing it.
  TOKEN_ENCRYPTION_KEY: z.string().min(1),

  DATABASE_PATH: z.string().default('data/app.db'),
  POLL_INTERVAL_SECONDS: z.coerce.number().default(300),
  // Debounce for webhook-triggered jobs: collapses HubSpot's per-property events and lets
  // the attribution beacon land before a form submission is processed.
  WEBHOOK_DEBOUNCE_MS: z.coerce.number().default(1500),
  INSTANCE_TOKEN_MAX_AGE_HOURS: z.coerce.number().default(24),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${missing}`);
  }
  if (parsed.data.SECRET_STORE === 'gcp' && !parsed.data.GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID is required when SECRET_STORE=gcp');
  }
  return parsed.data;
}
