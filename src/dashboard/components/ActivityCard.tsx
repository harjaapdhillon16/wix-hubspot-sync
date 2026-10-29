import { useEffect, useState } from 'react';
import { Card, Box, Text, Badge, EmptyState, TextButton } from '@wix/design-system';
import type { ActivityEntry } from '../../shared/types';
import { api } from '../api';

const ARROW: Record<string, string> = { wix_to_hubspot: 'Wix → HubSpot', hubspot_to_wix: 'HubSpot → Wix', both: 'Both' };
const SKIN: Record<string, 'success' | 'neutralLight' | 'warning' | 'general' | 'danger'> = {
  created: 'success',
  updated: 'general',
  no_change: 'neutralLight',
  echo_ignored: 'neutralLight',
  skipped: 'warning',
};

/** Recent sync decisions. Only ids and field names are shown — never contact values. */
export function ActivityCard({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void api.activity().then((a) => setItems(a.sync)).catch(() => undefined);
  }, [refreshKey, tick]);

  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 5000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <Card stretchVertically>
      <Card.Header title="Sync activity" subtitle="Live log of sync decisions, including echoes that were suppressed." suffix={<TextButton size="small" onClick={() => setTick((x) => x + 1)}>Refresh</TextButton>} />
      <Card.Divider />
      <Card.Content>
        {items.length === 0 ? (
          <EmptyState theme="section" title="No activity yet" subtitle="Edit a contact in Wix or HubSpot to see it sync." />
        ) : (
          <Box direction="vertical" gap="SP2" maxHeight="420px" overflow="auto">
            {items.slice(0, 30).map((a, i) => (
              <Box key={i} direction="vertical" gap="SP0" paddingBottom="SP2" style={{ borderBottom: '1px solid #ECEFF3' }}>
                <Box gap="SP2" verticalAlign="middle">
                  <Badge size="tiny" skin={SKIN[a.action] ?? 'general'}>
                    {a.action.replace(/_/g, ' ')}
                  </Badge>
                  <Text size="tiny">{ARROW[a.direction] ?? a.direction}</Text>
                  <Text size="tiny" secondary>
                    {new Date(a.ts).toLocaleTimeString()}
                  </Text>
                </Box>
                {(a.fields.length > 0 || a.detail) && (
                  <Text size="tiny" secondary>
                    {a.fields.length > 0 && `fields: ${a.fields.join(', ')}`}
                    {a.fields.length > 0 && a.detail && ' · '}
                    {a.detail}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Card.Content>
    </Card>
  );
}
