import { useCallback, useEffect, useState } from 'react';
import { deleteLocal } from '../evidence';
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { SyncClient, WorkPackage } from '@inspectionflow/sync-client';
import { i18n, label, Lang, tr } from '../i18n';

export function TasksScreen({
  lang,
  client,
  onOpen,
  onSignOut,
  onToggleLang,
}: {
  lang: Lang;
  client: SyncClient;
  onOpen: (task: any, inspectable: any) => void;
  onSignOut: () => void;
  onToggleLang: () => void;
}) {
  const [pkg, setPkg] = useState<WorkPackage | null>(null);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);

  const refreshLocal = useCallback(async () => {
    setPkg(await client.workPackage());
    const box = await client.outbox();
    setPending(box.filter((m) => m.state === 'PENDING').length);
    setFailed(box.filter((m) => m.state === 'FAILED').length);
  }, [client]);

  const sync = useCallback(async () => {
    setBusy(true);
    const r = await client.sync({ refreshBundle: true });
    await deleteLocal(r.uploaded);
    setOnline(r.online);
    await refreshLocal();
    setBusy(false);
  }, [client, refreshLocal]);

  useEffect(() => {
    refreshLocal().then(sync);
    // Sync automatically whenever connectivity returns.
    return NetInfo.addEventListener((st) => {
      if (st.isConnected) sync();
      else setOnline(false);
    });
  }, [refreshLocal, sync]);

  const inspectables = new Map((pkg?.inspectables ?? []).map((i) => [i.id, i]));
  const tasks = (pkg?.tasks ?? []).filter((t) => t.task_type === 'INSPECT');

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Text style={s.title}>{tr(lang, 'tasks')}</Text>
        <View style={s.row}>
          <TouchableOpacity onPress={onToggleLang}><Text style={s.link}>{lang === 'ar' ? 'EN' : 'ع'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={onSignOut}><Text style={s.link}>{tr(lang, 'signOut')}</Text></TouchableOpacity>
        </View>
      </View>
      <View style={s.status}>
        <Text style={[s.badge, { backgroundColor: online ? '#e5f4e4' : '#fbebeb' }]}>{tr(lang, online ? 'online' : 'offline')}</Text>
        <Text style={s.badge}>{`${tr(lang, 'pending')}: ${pending}`}</Text>
        {failed > 0 && <Text style={[s.badge, { backgroundColor: '#f9ece7' }]}>{`${tr(lang, 'failed')}: ${failed}`}</Text>}
        <TouchableOpacity style={s.syncBtn} onPress={sync} disabled={busy}>
          <Text style={s.syncText}>{busy ? '…' : tr(lang, 'sync')}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={sync} />}
        ListEmptyComponent={<Text style={s.empty}>{tr(lang, 'noTasks')}</Text>}
        renderItem={({ item }) => {
          const ins = inspectables.get(item.inspectable_id);
          return (
            <TouchableOpacity style={s.card} onPress={() => ins && onOpen(item, ins)}>
              <Text style={s.cardTitle}>{ins ? `${i18n(lang, ins.name_i18n, ins.name)} (${ins.identifier})` : item.log_number}</Text>
              <Text style={s.meta}>{`${label(lang, item.task_type)} · ${item.process_code ?? ''} · ${item.log_number ?? ''}`}</Text>
              {item.due_at && <Text style={s.meta}>{`${tr(lang, 'due')}: ${new Date(item.due_at).toLocaleDateString(lang === 'ar' ? 'ar-AE' : 'en-GB')}`}</Text>}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f3f5f8' },
  header: { backgroundColor: '#0b2545', paddingTop: 48, paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 16 },
  link: { color: '#cfd8e3', fontSize: 15 },
  status: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12, alignItems: 'center' },
  badge: { backgroundColor: '#e7f1fb', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 13, overflow: 'hidden' },
  syncBtn: { marginStart: 'auto', backgroundColor: '#13579b', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  syncText: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#e2e6ec' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#1d2433', textAlign: 'left' },
  meta: { fontSize: 13, color: '#5a6575', marginTop: 4, textAlign: 'left' },
  empty: { textAlign: 'center', color: '#5a6575', padding: 32 },
});
