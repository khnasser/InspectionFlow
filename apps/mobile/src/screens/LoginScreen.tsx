import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Lang, tr } from '../i18n';
import { devLogin, Session } from '../session';

export function LoginScreen({ lang, onSignedIn }: { lang: Lang; onSignedIn: (s: Session) => void }) {
  // 10.0.2.2 reaches the host machine from the Android emulator.
  const [baseUrl, setBaseUrl] = useState('http://10.0.2.2:3000');
  const [tenant, setTenant] = useState('DEMO-AUTH');
  const [email, setEmail] = useState('ahmed@demoauth.inspectionflow.test');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      onSignedIn(await devLogin(baseUrl.replace(/\/$/, ''), tenant, email.trim().toLowerCase()));
    } catch (e) {
      Alert.alert(tr(lang, 'signIn'), String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.wrap}>
      <Text style={s.title}>InspectionFlow</Text>
      <Text style={s.label}>{tr(lang, 'server')}</Text>
      <TextInput style={s.input} value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" />
      <Text style={s.label}>{tr(lang, 'tenant')}</Text>
      <TextInput style={s.input} value={tenant} onChangeText={setTenant} autoCapitalize="characters" />
      <Text style={s.label}>{tr(lang, 'email')}</Text>
      <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <TouchableOpacity style={s.button} onPress={go} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>{tr(lang, 'signIn')}</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#f3f5f8' },
  title: { fontSize: 28, fontWeight: '700', color: '#0b2545', marginBottom: 24, textAlign: 'center' },
  label: { fontSize: 13, color: '#4a5568', marginTop: 12, marginBottom: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#c9ced6', borderRadius: 8, padding: 12, fontSize: 15 },
  button: { marginTop: 24, backgroundColor: '#13579b', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
