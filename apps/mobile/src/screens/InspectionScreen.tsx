import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { InspectionResult, uuidv7 } from '@inspectionflow/engine';
import type { AttachmentDraft, ConfigBundle, FindingDraft, SyncClient, WorkPackage } from '@inspectionflow/sync-client';
import { Image } from 'react-native';
import { capturePhoto, deleteLocal } from '../evidence';
import { SignaturePad } from '../components/SignaturePad';
import { i18n, label, Lang, tr } from '../i18n';

type Answer = 'YES' | 'NO' | 'NA';

export function InspectionScreen({
  lang,
  client,
  task,
  inspectable,
  onDone,
}: {
  lang: Lang;
  client: SyncClient;
  task: any;
  inspectable: any;
  onDone: () => void;
}) {
  const startedAt = useMemo(() => new Date().toISOString(), []);
  // Generated up front so photos can reference the inspection before it is queued.
  const inspectionId = useMemo(() => uuidv7(), []);
  const [photos, setPhotos] = useState<AttachmentDraft[]>([]);
  const [bundle, setBundle] = useState<ConfigBundle | null>(null);
  const [pkg, setPkg] = useState<WorkPackage | null>(null);
  const [findings, setFindings] = useState<FindingDraft[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [remarks, setRemarks] = useState('');
  const [signer, setSigner] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [result, setResult] = useState<InspectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.configBundle().then(setBundle);
    client.workPackage().then(setPkg);
  }, [client]);

  const process = bundle?.processes.find((p) => p.code === task.process_code);
  const checklist = process?.checklists?.[0];
  const openFindings = (pkg?.openFindings ?? []).filter((f) => f.inspectable_id === inspectable.id);
  const parties: Array<{ partyId: string; name: string; role: string }> = inspectable.parties ?? [];

  // Provisional engine result, recalculated offline on every change.
  useEffect(() => {
    if (!process) return;
    client
      .provisional({ processCode: process.code, inspectableId: inspectable.id, findings, completedAt: new Date().toISOString() })
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [client, process, inspectable.id, findings]);

  async function addPhoto(ownerType: 'FINDING' | 'INSPECTION', ownerId: string) {
    try {
      const p = await capturePhoto({ ownerType, ownerId });
      if (p) setPhotos((x) => [...x, p]);
    } catch (e) {
      Alert.alert(tr(lang, 'evidence'), String((e as Error).message ?? e));
    }
  }

  const PhotoStrip = ({ ownerId, ownerType }: { ownerId: string; ownerType: 'FINDING' | 'INSPECTION' }) => (
    <View style={[s.row, { flexWrap: 'wrap', marginTop: 6 }]}>
      {photos.filter((p) => p.ownerId === ownerId).map((p) => (
        <TouchableOpacity key={p.id} onLongPress={() => { setPhotos((x) => x.filter((y) => y.id !== p.id)); deleteLocal([p.localUri]); }}>
          <Image source={{ uri: p.localUri }} style={s.thumb} />
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={s.chip} onPress={() => addPhoto(ownerType, ownerId)}>
        <Text style={s.chipText}>{`📷 ${tr(lang, 'takePhoto')}`}</Text>
      </TouchableOpacity>
    </View>
  );

  const update = (id: string, patch: Partial<FindingDraft>) => setFindings((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function submit() {
    if (!process) return;
    if (!refused && findings.length > 0 && (!signer || !signature)) {
      Alert.alert(tr(lang, 'sign'), tr(lang, 'signer'));
      return;
    }
    const signatureSha256 = signature
      ? await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, signature)
      : undefined;
    // Photos of removed findings are dropped; the rest are queued before the inspection.
    const keep = photos.filter((p) => p.ownerId === inspectionId || findings.some((f) => f.id === p.ownerId));
    await deleteLocal(photos.filter((p) => !keep.includes(p)).map((p) => p.localUri));
    for (const p of keep) await client.addAttachment(p);
    await client.enqueueInspection({
      id: inspectionId,
      processCode: process.code,
      inspectableId: inspectable.id,
      kind: openFindings.length ? 'FOLLOW_UP' : 'SCHEDULED',
      taskId: task.id,
      startedAt,
      completedAt: new Date().toISOString(),
      generalRemarks: remarks || undefined,
      findings,
      resolvedFindingIds: resolved,
      checklist: Object.entries(answers).map(([itemId, value]) => ({ itemId, value })),
      signature: refused
        ? { method: 'REFUSED', signerName: signer || '-' }
        : signature
          ? { method: 'CANVAS', signerName: signer, signatureSha256 }
          : undefined,
    });
    const r = await client.sync();
    await deleteLocal(r.uploaded);
    Alert.alert(r.online && r.pending === 0 && r.photosPending === 0 ? tr(lang, 'sent') : tr(lang, 'queued'));
    onDone();
  }

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ paddingBottom: 48 }}>
      <View style={s.header}>
        <TouchableOpacity onPress={onDone}><Text style={s.link}>{tr(lang, 'back')}</Text></TouchableOpacity>
        <Text style={s.title}>{`${i18n(lang, inspectable.name_i18n, inspectable.name)} (${inspectable.identifier})`}</Text>
        <Text style={s.sub}>{i18n(lang, process?.name_i18n, task.process_code)}</Text>
      </View>

      {openFindings.length > 0 && (
        <Section title={tr(lang, 'openFindings')}>
          {openFindings.map((f) => (
            <View key={f.id} style={s.rowBetween}>
              <Text style={s.text}>{`${f.violation_code} · ${label(lang, f.final_severity)}`}</Text>
              <View style={s.row}>
                <Text style={s.small}>{tr(lang, 'resolved')}</Text>
                <Switch value={resolved.includes(f.id)} onValueChange={(v) => setResolved((r) => (v ? [...r, f.id] : r.filter((x) => x !== f.id)))} />
              </View>
            </View>
          ))}
        </Section>
      )}

      {checklist && (
        <Section title={tr(lang, 'checklist')}>
          {checklist.sections.flatMap((sec: any) => sec.items).map((item: any) => (
            <View key={item.id} style={s.item}>
              <Text style={s.text}>{i18n(lang, item.label, item.code)}</Text>
              <View style={s.row}>
                {(['YES', 'NO', 'NA'] as Answer[]).map((a) => (
                  <TouchableOpacity key={a} style={[s.chip, answers[item.id] === a && s.chipOn]} onPress={() => setAnswers((x) => ({ ...x, [item.id]: a }))}>
                    <Text style={answers[item.id] === a ? s.chipTextOn : s.chipText}>{tr(lang, a === 'YES' ? 'yes' : a === 'NO' ? 'no' : 'na')}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
        </Section>
      )}

      <Section title={tr(lang, 'findings')}>
        {findings.map((f) => {
          const v = process?.violations.find((x) => x.code === f.violationCode);
          return (
            <View key={f.id} style={s.finding}>
              <View style={s.rowBetween}>
                <Text style={s.bold}>{`${f.violationCode} — ${i18n(lang, v?.description_i18n, '')}`}</Text>
                <TouchableOpacity onPress={() => setFindings((fs) => fs.filter((x) => x.id !== f.id))}><Text style={s.remove}>×</Text></TouchableOpacity>
              </View>
              <Text style={s.small}>{tr(lang, 'parties')}</Text>
              <View style={[s.row, { flexWrap: 'wrap' }]}>
                {parties.map((p) => {
                  const on = f.partyIds.includes(p.partyId);
                  return (
                    <TouchableOpacity key={p.partyId + p.role} style={[s.chip, on && s.chipOn]}
                      onPress={() => update(f.id, { partyIds: on ? f.partyIds.filter((x) => x !== p.partyId) : [...f.partyIds, p.partyId] })}>
                      <Text style={on ? s.chipTextOn : s.chipText}>{`${p.name} · ${p.role}`}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TextInput style={s.input} placeholder={tr(lang, 'remarks')} value={f.remarks} onChangeText={(t) => update(f.id, { remarks: t })} />
              <PhotoStrip ownerType="FINDING" ownerId={f.id} />
            </View>
          );
        })}
        <Text style={[s.small, { marginTop: 8 }]}>{tr(lang, 'addViolation')}</Text>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {(process?.violations ?? [])
            .filter((v) => !findings.some((f) => f.violationCode === v.code))
            .map((v) => (
              <TouchableOpacity key={v.code} style={s.chip} onPress={() => setFindings((fs) => [...fs, { id: uuidv7(), violationCode: v.code, partyIds: [] }])}>
                <Text style={s.chipText}>{`+ ${v.code}`}</Text>
              </TouchableOpacity>
            ))}
        </View>
      </Section>

      <Section title={tr(lang, 'evidence')}>
        <PhotoStrip ownerType="INSPECTION" ownerId={inspectionId} />
      </Section>

      {result && findings.length > 0 && (
        <Section title={tr(lang, 'result')}>
          {result.findings.map((r) => (
            <Text key={r.violationCode} style={s.text}>
              {`${r.violationCode}: ${tr(lang, 'occurrence')} ${r.occurrence} → ${label(lang, r.actionCode)} (${label(lang, r.severity)}) · ${tr(lang, 'fine')} ${r.fine} · ${r.resolveBy}`}
            </Text>
          ))}
          <Text style={s.bold}>{`${tr(lang, 'total')}: ${result.totalFine} ${tr(lang, 'aed')} · ${tr(lang, 'review')}: ${label(lang, result.review)} · ${tr(lang, 'followUp')}: ${result.followUpDate ?? '-'}`}</Text>
          <Text style={s.small}>{tr(lang, 'serverNote')}</Text>
        </Section>
      )}
      {error && <Text style={[s.small, { color: '#b42318', padding: 12 }]}>{error}</Text>}

      <Section title={tr(lang, 'sign')}>
        <TextInput style={s.input} placeholder={tr(lang, 'signer')} value={signer} onChangeText={setSigner} />
        <View style={s.rowBetween}>
          <Text style={s.small}>{tr(lang, 'refused')}</Text>
          <Switch value={refused} onValueChange={setRefused} />
        </View>
        {!refused && <SignaturePad onChange={setSignature} />}
        <TextInput style={[s.input, { minHeight: 60 }]} multiline placeholder={tr(lang, 'remarks')} value={remarks} onChangeText={setRemarks} />
      </Section>

      <TouchableOpacity style={s.submit} onPress={submit}>
        <Text style={s.submitText}>{tr(lang, 'submit')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  thumb: { width: 64, height: 64, borderRadius: 6, marginEnd: 6, marginBottom: 6, backgroundColor: '#dde2e8' },
  wrap: { flex: 1, backgroundColor: '#f3f5f8' },
  header: { backgroundColor: '#0b2545', paddingTop: 48, paddingHorizontal: 16, paddingBottom: 14 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 8, textAlign: 'left' },
  sub: { color: '#cfd8e3', fontSize: 13, marginTop: 2, textAlign: 'left' },
  link: { color: '#cfd8e3', fontSize: 15, textAlign: 'left' },
  section: { backgroundColor: '#fff', margin: 12, marginBottom: 0, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#e2e6ec', gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#0b2545', textAlign: 'left' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  item: { gap: 6, paddingVertical: 4 },
  text: { fontSize: 14, color: '#1d2433', textAlign: 'left' },
  bold: { fontSize: 14, fontWeight: '600', color: '#1d2433', flexShrink: 1, textAlign: 'left' },
  small: { fontSize: 12, color: '#5a6575', textAlign: 'left' },
  chip: { borderWidth: 1, borderColor: '#13579b', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginTop: 4 },
  chipOn: { backgroundColor: '#13579b' },
  chipText: { color: '#13579b', fontSize: 13 },
  chipTextOn: { color: '#fff', fontSize: 13 },
  finding: { borderWidth: 1, borderColor: '#e2e6ec', borderRadius: 8, padding: 10, gap: 6 },
  remove: { color: '#b42318', fontSize: 22, paddingHorizontal: 8 },
  input: { borderWidth: 1, borderColor: '#c9ced6', borderRadius: 8, padding: 10, fontSize: 14, textAlign: 'right' },
  submit: { backgroundColor: '#13579b', margin: 12, marginTop: 16, padding: 16, borderRadius: 10, alignItems: 'center' },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
