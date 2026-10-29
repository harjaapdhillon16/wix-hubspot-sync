import { useState } from 'react';
import { Card, Box, Text, Dropdown, ToggleSwitch, FormField } from '@wix/design-system';
import type { ConflictStrategy, StatusResponse } from '../../shared/types';
import { api } from '../api';

const STRATEGIES: Array<{ id: ConflictStrategy; value: string; help: string }> = [
  { id: 'last_updated_wins', value: 'Last updated wins', help: 'When both sides changed the same field, the most recently updated record wins.' },
  { id: 'hubspot_wins', value: 'HubSpot wins', help: 'When both sides changed the same field, HubSpot’s value is kept.' },
  { id: 'wix_wins', value: 'Wix wins', help: 'When both sides changed the same field, Wix’s value is kept.' },
];

export function SettingsCard({ status, onChange }: { status: StatusResponse; onChange: () => void }) {
  const [saving, setSaving] = useState(false);
  const current = STRATEGIES.find((s) => s.id === status.conflictStrategy)!;

  async function save(patch: { conflictStrategy?: ConflictStrategy; syncEnabled?: boolean }) {
    setSaving(true);
    try {
      await api.saveSettings(patch);
      onChange();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card stretchVertically>
      <Card.Header title="Sync settings" />
      <Card.Divider />
      <Card.Content>
        <Box direction="vertical" gap="SP4">
          <Box verticalAlign="middle" gap="SP2">
            <ToggleSwitch checked={status.syncEnabled} disabled={saving} onChange={() => save({ syncEnabled: !status.syncEnabled })} />
            <Text size="small">Automatic two-way sync {status.syncEnabled ? 'on' : 'paused'}</Text>
          </Box>
          <FormField label="Conflict rule" infoContent={current.help}>
            <Dropdown
              size="small"
              options={STRATEGIES.map(({ id, value }) => ({ id, value }))}
              selectedId={status.conflictStrategy}
              disabled={saving}
              onSelect={(o) => save({ conflictStrategy: o.id as ConflictStrategy })}
            />
          </FormField>
          <Text size="tiny" secondary>
            {current.help}
          </Text>
        </Box>
      </Card.Content>
    </Card>
  );
}
