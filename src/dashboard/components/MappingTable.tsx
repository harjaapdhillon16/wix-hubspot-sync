import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Box, Text, Button, Dropdown, Input, IconButton, AutoComplete, SectionHelper, Loader, Tooltip } from '@wix/design-system';
import { Add, Delete } from '@wix/wix-ui-icons-common';
import type { Direction, FieldMapping, HubSpotPropertyOption, Transform, ValidationIssue, WixFieldOption } from '../../shared/types';
import { api, ApiError } from '../api';

const DIRECTION_OPTIONS: Array<{ id: Direction; value: string }> = [
  { id: 'bidirectional', value: 'Wix ⇄ HubSpot' },
  { id: 'wix_to_hubspot', value: 'Wix → HubSpot' },
  { id: 'hubspot_to_wix', value: 'HubSpot → Wix' },
];
const TRANSFORM_OPTIONS: Array<{ id: Transform; value: string }> = [
  { id: 'none', value: 'No transform' },
  { id: 'trim', value: 'Trim spaces' },
  { id: 'lowercase', value: 'lowercase' },
  { id: 'uppercase', value: 'UPPERCASE' },
  { id: 'titlecase', value: 'Title Case' },
];

type Row = FieldMapping & { key: number };
let nextKey = 1;
const withKeys = (m: FieldMapping[]): Row[] => m.map((r) => ({ ...r, key: nextKey++ }));

/** Client-side mirror of the server rules, for instant feedback (the server re-validates). */
function validate(rows: Row[], props: Map<string, HubSpotPropertyOption>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hsTargets = new Map<string, number>();
  const wixTargets = new Map<string, number>();
  if (!rows.some((r) => r.wixField === 'email' && r.hubspotProperty === 'email' && r.direction === 'bidirectional')) {
    issues.push({ row: null, message: 'Keep the Primary email ⇄ Email row: it is how contacts are matched.' });
  }
  rows.forEach((r, i) => {
    const row = i + 1;
    if (!r.wixField || !r.hubspotProperty) return void issues.push({ row, message: 'Choose both a Wix field and a HubSpot property.' });
    if (props.size && !props.has(r.hubspotProperty)) issues.push({ row, message: `Unknown HubSpot property “${r.hubspotProperty}”.` });
    if (props.get(r.hubspotProperty)?.readOnly && r.direction !== 'hubspot_to_wix') issues.push({ row, message: 'This HubSpot property is read-only — use HubSpot → Wix.' });
    if (r.direction !== 'hubspot_to_wix') {
      if (hsTargets.has(r.hubspotProperty)) issues.push({ row, message: `HubSpot property already mapped in row ${hsTargets.get(r.hubspotProperty)}.` });
      else hsTargets.set(r.hubspotProperty, row);
    }
    if (r.direction !== 'wix_to_hubspot') {
      if (wixTargets.has(r.wixField)) issues.push({ row, message: `Wix field already written by row ${wixTargets.get(r.wixField)}.` });
      else wixTargets.set(r.wixField, row);
    }
  });
  return issues;
}

export function MappingTable({ connected }: { connected: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [wixFields, setWixFields] = useState<WixFieldOption[]>([]);
  const [hsProps, setHsProps] = useState<HubSpotPropertyOption[]>([]);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [{ mappings }, fields] = await Promise.all([api.mappings(), api.fields()]);
      setRows(withKeys(mappings));
      setSaved(JSON.stringify(mappings));
      setWixFields(fields.wixFields);
      setHsProps(fields.hubspotProperties);
    })().catch((err) => setMessage((err as Error).message));
  }, [connected]);

  const propMap = useMemo(() => new Map(hsProps.map((p) => [p.name, p])), [hsProps]);
  const issues = useMemo(() => (rows ? validate(rows, propMap) : []), [rows, propMap]);
  const allIssues = serverIssues.length ? serverIssues : issues;
  const strip = (r: Row[]) => r.map(({ key: _key, ...m }) => ({ ...m, defaultValue: m.defaultValue || null }));
  const dirty = rows ? JSON.stringify(strip(rows)) !== JSON.stringify(JSON.parse(saved || '[]').map((m: FieldMapping) => ({ ...m, defaultValue: m.defaultValue || null }))) : false;

  const update = (key: number, patch: Partial<FieldMapping>) => {
    setServerIssues([]);
    setMessage(null);
    setRows((rs) => rs!.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  async function save() {
    if (!rows) return;
    setSaving(true);
    setMessage(null);
    try {
      const { mappings } = await api.saveMappings(strip(rows));
      setRows(withKeys(mappings));
      setSaved(JSON.stringify(mappings));
      setMessage('Mapping saved. New syncs use these rules immediately.');
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setServerIssues(err.issues);
      else setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const wixOptions = wixFields.map((f) => ({ id: f.key, value: f.label }));
  const rowIssue = (i: number) => allIssues.find((x) => x.row === i + 1)?.message;
  const COLS = '2.2fr 2.4fr 1.5fr 1.4fr 1.3fr 40px';

  return (
    <Card>
      <Card.Header
        title="Field mapping"
        subtitle="Choose which Wix contact fields sync to which HubSpot properties, and in which direction."
        suffix={
          <Box gap="SP2">
            <Button size="small" priority="secondary" prefixIcon={<Add />} disabled={!rows} onClick={() => setRows((rs) => [...(rs ?? []), { key: nextKey++, wixField: '', hubspotProperty: '', direction: 'bidirectional', transform: 'none', defaultValue: null }])}>
              Add mapping
            </Button>
            <Button size="small" onClick={save} disabled={!rows || saving || !dirty || issues.length > 0} dataHook="save-mapping">
              {saving ? 'Saving…' : 'Save mapping'}
            </Button>
          </Box>
        }
      />
      <Card.Divider />
      <Card.Content>
        {!connected && (
          <Box marginBottom="SP3">
            <SectionHelper appearance="standard">Connect HubSpot to load your HubSpot properties. You can still review the default mapping.</SectionHelper>
          </Box>
        )}
        {!rows ? (
          <Box align="center" padding="SP6">
            <Loader size="small" />
          </Box>
        ) : (
          <Box direction="vertical" gap="SP2">
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '0 4px' }}>
              {['Wix field', 'HubSpot property', 'Sync direction', 'Transform', 'Default if empty', ''].map((h) => (
                <Text key={h} size="tiny" weight="bold" secondary>
                  {h}
                </Text>
              ))}
            </div>
            {rows.map((r, i) => {
              const locked = r.wixField === 'email' && r.hubspotProperty === 'email';
              const issue = rowIssue(i);
              return (
                <div key={r.key} data-hook="mapping-row">
                  <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', padding: 4, borderRadius: 6, background: issue ? 'rgba(238,77,77,0.06)' : undefined }}>
                    <Dropdown size="small" placeholder="Select Wix field" options={wixOptions} selectedId={r.wixField || undefined} disabled={locked} onSelect={(o) => update(r.key, { wixField: String(o.id) })} />
                    <HubSpotPropertyPicker value={r.hubspotProperty} props={hsProps} disabled={locked} status={issue ? 'error' : undefined} onChange={(name) => update(r.key, { hubspotProperty: name })} />
                    <Dropdown size="small" options={DIRECTION_OPTIONS} selectedId={r.direction} disabled={locked} onSelect={(o) => update(r.key, { direction: o.id as Direction })} />
                    <Dropdown size="small" options={TRANSFORM_OPTIONS} selectedId={r.transform} onSelect={(o) => update(r.key, { transform: o.id as Transform })} />
                    <Input size="small" placeholder="—" value={r.defaultValue ?? ''} disabled={locked} onChange={(e) => update(r.key, { defaultValue: e.target.value })} />
                    <Tooltip content={locked ? 'Required: contacts are matched by email' : 'Remove row'}>
                      <IconButton size="small" skin="light" priority="secondary" disabled={locked} onClick={() => setRows((rs) => rs!.filter((x) => x.key !== r.key))}>
                        <Delete />
                      </IconButton>
                    </Tooltip>
                  </div>
                  {issue && (
                    <Box paddingLeft="SP1">
                      <Text size="tiny" skin="error">
                        {issue}
                      </Text>
                    </Box>
                  )}
                </div>
              );
            })}
            {allIssues
              .filter((x) => x.row === null)
              .map((x) => (
                <SectionHelper key={x.message} appearance="danger">
                  {x.message}
                </SectionHelper>
              ))}
            {message && (
              <Text size="small" skin="success">
                {message}
              </Text>
            )}
          </Box>
        )}
      </Card.Content>
    </Card>
  );
}

/** HubSpot portals have hundreds of contact properties, so this is a searchable picker. */
function HubSpotPropertyPicker({ value, props, disabled, status, onChange }: { value: string; props: HubSpotPropertyOption[]; disabled?: boolean; status?: 'error'; onChange: (name: string) => void }) {
  const labelOf = (name: string) => props.find((p) => p.name === name)?.label ?? name;
  const [text, setText] = useState(labelOf(value));
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => setText(labelOf(value)), [value, props]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = props.map((p) => ({ id: p.name, value: p.readOnly ? `${p.label} (read-only)` : p.label }));
  const q = text.trim().toLowerCase();
  return (
    <AutoComplete
      size="small"
      placeholder={props.length ? 'Search HubSpot properties' : 'Connect HubSpot first'}
      options={options}
      value={text}
      disabled={disabled || !props.length}
      status={status}
      onChange={(e) => setText(e.target.value)}
      onSelect={(o) => {
        onChange(String(o.id));
        setText(labelOf(String(o.id)));
      }}
      // Leaving the field without choosing reverts to the saved property (delayed so an option click lands first).
      onBlur={() => window.setTimeout(() => setText(labelOf(latest.current)), 200)}
      // AutoComplete applies the predicate while the user is typing; match label or internal name.
      predicate={(o) => !q || String(o.value).toLowerCase().includes(q) || String(o.id).toLowerCase().includes(q)}
      emptyStateMessage="No matching HubSpot property"
    />
  );
}
