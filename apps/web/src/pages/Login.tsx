import { Alert, Button, Card, Form, Input, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { api, session, SessionUser } from '../api';
import { notifyError } from '../hooks';
import { useI18n } from '../i18n';

const DEMO_USERS = [
  ['ahmed', 'Ahmed Al Mansoori — Inspector'],
  ['omar', 'Omar Haddad — Inspector'],
  ['sara', 'Sara Al Suwaidi — Section manager'],
  ['khalid', 'Khalid Al Falasi — Committee / Director'],
  ['ceo', 'Mariam Al Hashimi — CEO'],
  ['admin', 'Platform admin'],
];

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [busy, setBusy] = useState(false);

  async function submit(v: { tenantCode: string; user: string }) {
    setBusy(true);
    try {
      const domain = `${v.tenantCode.toLowerCase().replace(/[^a-z0-9]/g, '')}.inspectionflow.test`;
      const res = await api.post<{ accessToken: string; user: SessionUser }>('/v1/dev/login', {
        tenantCode: v.tenantCode,
        email: v.user.includes('@') ? v.user : `${v.user}@${domain}`,
      });
      session.set(res.accessToken, res.user);
      onSignedIn();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f3f5f8', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {t('appName')}
            </Typography.Title>
            <Button size="small" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              {lang === 'ar' ? 'English' : 'العربية'}
            </Button>
          </Space>
          <Alert type="info" showIcon message={t('devNote')} />
          <Form layout="vertical" initialValues={{ tenantCode: 'DEMO-AUTH', user: 'ahmed' }} onFinish={submit}>
            <Form.Item name="tenantCode" label={t('tenant')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="user" label={t('user')} rules={[{ required: true }]}>
              <Select options={DEMO_USERS.map(([value, label]) => ({ value, label }))} />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              {t('signIn')}
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
