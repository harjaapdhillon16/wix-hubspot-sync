import { useEffect, useState } from 'react';
import { Card, Box, Text, Badge, EmptyState, SectionHelper } from '@wix/design-system';
import type { FormEventEntry, StatusResponse } from '../../shared/types';
import { api } from '../api';

export function FormsCard({ status, refreshKey }: { status: StatusResponse; refreshKey: number }) {
  const [items, setItems] = useState<FormEventEntry[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void api.activity().then((a) => setItems(a.forms)).catch(() => undefined);
  }, [refreshKey, tick]);

  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 5000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <Card stretchVertically>
      <Card.Header
        title="Form lead capture"
        subtitle="Wix Forms submissions are sent to HubSpot with UTM source, page URL and referrer."
        suffix={<Badge skin={status.scriptEmbedded ? 'success' : 'neutralLight'}>{status.scriptEmbedded ? 'Tracking active' : 'Tracking inactive'}</Badge>}
      />
      <Card.Divider />
      <Card.Content>
        <Box direction="vertical" gap="SP3">
          <SectionHelper appearance="standard" title="Where to find it in HubSpot">
            Contact properties in the “Wix integration” group: <b>Wix utm_source/medium/campaign/term/content (last touch)</b>, <b>Wix utm_source/medium/campaign (first touch)</b>, <b>Wix landing page</b>,{' '}
            <b>Wix form page URL</b>, <b>Wix referrer</b>, <b>Wix form submitted at</b>, <b>Wix form ID</b>.
          </SectionHelper>
          {items.length === 0 ? (
            <EmptyState theme="section" title="No submissions yet" subtitle="Submit any Wix form on your site to see it here." />
          ) : (
            <Box direction="vertical" gap="SP2" maxHeight="300px" overflow="auto">
              {items.map((f) => (
                <Box key={f.submissionId + f.ts} verticalAlign="middle" gap="SP2" paddingBottom="SP2" style={{ borderBottom: '1px solid #ECEFF3' }}>
                  <Badge size="tiny" skin={f.status === 'skipped' ? 'warning' : 'success'}>
                    {f.status}
                  </Badge>
                  <Box direction="vertical">
                    <Text size="tiny">
                      {f.utmSource ? `${f.utmSource} / ${f.utmMedium ?? '—'} / ${f.utmCampaign ?? '—'}` : 'direct / no UTM'}
                    </Text>
                    <Text size="tiny" secondary>
                      {new Date(f.ts).toLocaleString()} · HubSpot contact {f.hubspotContactId ?? '—'} {f.latencyMs != null && `· ${(f.latencyMs / 1000).toFixed(1)}s`}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Card.Content>
    </Card>
  );
}
