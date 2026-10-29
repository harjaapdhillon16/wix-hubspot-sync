import { useEffect, useRef, useState } from 'react';
import { Card, Box, Text, Button, Badge, Heading } from '@wix/design-system';
import type { StatusResponse } from '../../shared/types';
import { api } from '../api';

export function ConnectionCard({ status, onChange }: { status: StatusResponse; onChange: () => void }) {
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'sync' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => () => void (poll.current && window.clearInterval(poll.current)), []);

  async function connect() {
    setBusy('connect');
    setNotice(null);
    try {
      const { authorizeUrl } = await api.connect();
      // HubSpot's consent screen can't be framed inside the Wix dashboard, so use a popup.
      const popup = window.open(authorizeUrl, 'hubspot-oauth', 'width=640,height=760');
      if (!popup) window.location.href = authorizeUrl;
      poll.current = window.setInterval(() => {
        if (popup?.closed) {
          window.clearInterval(poll.current!);
          setBusy(null);
          onChange();
        }
      }, 700);
    } catch (err) {
      setNotice((err as Error).message);
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect HubSpot? Sync stops and stored HubSpot tokens are revoked and deleted.')) return;
    setBusy('disconnect');
    try {
      await api.disconnect();
      onChange();
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      await api.fullSync();
      setNotice('Full sync queued. Contacts are matched by email; existing values are merged, not overwritten.');
      window.setTimeout(onChange, 2500);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const s = status.stats;
  return (
    <Card>
      <Card.Header
        title="HubSpot account"
        subtitle={status.connected ? `Connected to portal ${status.portalId}${status.hubDomain ? ` (${status.hubDomain})` : ''}` : 'Connect a HubSpot account to start syncing.'}
        suffix={<Badge skin={status.connected ? 'success' : 'neutralLight'}>{status.connected ? 'Connected' : 'Not connected'}</Badge>}
      />
      <Card.Divider />
      <Card.Content>
        {status.connected ? (
          <Box direction="vertical" gap="SP4">
            <Box gap="SP6">
              <Stat label="Linked contacts" value={s.linkedContacts} />
              <Stat label="Pending sync jobs" value={s.pendingJobs} />
              <Stat label="Failed jobs" value={s.failedJobs} />
              <Stat label="Form leads sent" value={s.formSubmissions} />
            </Box>
            <Text size="small" secondary>
              Granted scopes: {status.scopes.join(', ') || '—'}
            </Text>
            <Box gap="SP2">
              <Button size="small" onClick={syncNow} disabled={!!busy}>
                {busy === 'sync' ? 'Queuing…' : 'Sync all contacts now'}
              </Button>
              <Button size="small" priority="secondary" skin="destructive" onClick={disconnect} disabled={!!busy}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box direction="vertical" gap="SP3">
            <Text size="small">
              You'll be asked to sign in to HubSpot and approve read/write access to contacts and contact properties. Tokens are stored encrypted on our
              server and never sent to your browser.
            </Text>
            <Box>
              <Button onClick={connect} disabled={!!busy}>
                {busy === 'connect' ? 'Waiting for HubSpot…' : 'Connect HubSpot'}
              </Button>
            </Box>
          </Box>
        )}
        {notice && (
          <Box marginTop="SP3">
            <Text size="small" secondary>
              {notice}
            </Text>
          </Box>
        )}
      </Card.Content>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Box direction="vertical">
      <Heading size="large">{value}</Heading>
      <Text size="tiny" secondary>
        {label}
      </Text>
    </Box>
  );
}
