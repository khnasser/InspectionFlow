import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { SyncClient } from '@inspectionflow/sync-client';
import { Lang } from './i18n';
import { InspectionScreen } from './screens/InspectionScreen';
import { LoginScreen } from './screens/LoginScreen';
import { TasksScreen } from './screens/TasksScreen';
import { loadSession, saveSession, Session, syncClient, wipeLocalData } from './session';

export default function App() {
  const [lang, setLang] = useState<Lang>('ar');
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [client, setClient] = useState<SyncClient | null>(null);
  const [open, setOpen] = useState<{ task: any; inspectable: any } | null>(null);

  useEffect(() => {
    loadSession().then(setSession);
  }, []);
  useEffect(() => {
    if (session) syncClient(session).then(setClient);
    else setClient(null);
  }, [session]);

  if (session === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!session) {
    return (
      <LoginScreen
        lang={lang}
        onSignedIn={async (s) => {
          await saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  if (!client) return <ActivityIndicator style={{ flex: 1 }} />;

  return (
    <>
      <StatusBar style="light" />
      {open ? (
        <InspectionScreen lang={lang} client={client} task={open.task} inspectable={open.inspectable} onDone={() => setOpen(null)} />
      ) : (
        <TasksScreen
          lang={lang}
          client={client}
          onOpen={(task, inspectable) => setOpen({ task, inspectable })}
          onToggleLang={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          onSignOut={async () => {
            // Signing out keeps queued inspections; "wipe" is for revoked devices.
            await saveSession(null);
            setSession(null);
          }}
        />
      )}
    </>
  );
}

export { wipeLocalData };
