import { useCallback, useEffect, useState } from 'react';
import { Page, Layout, Cell, Loader, Box, SectionHelper } from '@wix/design-system';
import type { StatusResponse } from '../shared/types';
import { api } from './api';
import { ConnectionCard } from './components/ConnectionCard';
import { SettingsCard } from './components/SettingsCard';
import { MappingTable } from './components/MappingTable';
import { ActivityCard } from './components/ActivityCard';
import { FormsCard } from './components/FormsCard';

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === 'hubspot-oauth') void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  if (!api.hasInstance()) {
    return (
      <Box padding="SP6">
        <SectionHelper appearance="danger" title="Open this page from your Wix dashboard">
          The app could not identify your site. Open HubSpot Integration from the Apps menu of your Wix dashboard.
        </SectionHelper>
      </Box>
    );
  }

  return (
    <Page height="100vh">
      <Page.Header title="HubSpot Integration" subtitle="Keep Wix contacts and HubSpot in sync, and send Wix form leads to HubSpot with their source." />
      <Page.Content>
        {error && (
          <Box marginBottom="SP4">
            <SectionHelper appearance="danger">{error}</SectionHelper>
          </Box>
        )}
        {!status ? (
          <Box align="center" padding="SP10">
            <Loader />
          </Box>
        ) : (
          <Layout>
            <Cell span={8}>
              <ConnectionCard status={status} onChange={refresh} />
            </Cell>
            <Cell span={4}>
              <SettingsCard status={status} onChange={refresh} />
            </Cell>
            <Cell>
              <MappingTable connected={status.connected} />
            </Cell>
            <Cell span={6}>
              <FormsCard status={status} refreshKey={refreshKey} />
            </Cell>
            <Cell span={6}>
              <ActivityCard refreshKey={refreshKey} />
            </Cell>
          </Layout>
        )}
      </Page.Content>
    </Page>
  );
}
