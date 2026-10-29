import { ConfigProvider, Layout, Menu, Button, Space, Typography, Grid } from 'antd';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { session } from './api';
import { signOut } from './auth';
import { DelegateModal } from './components/DelegateModal';
import { I18nProvider, useI18n } from './i18n';
import { InspectableDetail } from './pages/InspectableDetail';
import { Inspectables } from './pages/Inspectables';
import { InspectionDetail } from './pages/InspectionDetail';
import { Login } from './pages/Login';
import { Payments } from './pages/Payments';
import { Reviews } from './pages/Reviews';
import { Tasks } from './pages/Tasks';
import { Team } from './pages/Team';

const REVIEWERS = ['SECTION_MANAGER', 'COMMITTEE', 'DIRECTOR', 'CEO', 'ADMIN'];

function Shell() {
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const loc = useLocation();
  const screens = Grid.useBreakpoint();
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [, force] = useState(0);

  if (!session.user) return <Login onSignedIn={() => force((n) => n + 1)} />;

  const items = [
    { key: '/tasks', label: t('myTasks') },
    ...(session.has(...REVIEWERS) ? [{ key: '/reviews', label: t('reviews') }] : []),
    { key: '/inspectables', label: t('inspectables') },
    { key: '/payments', label: t('payments') },
    ...(session.has('SECTION_MANAGER', 'ADMIN') ? [{ key: '/team', label: t('team') }] : []),
  ];
  const selected = items.find((i) => loc.pathname.startsWith(i.key))?.key ?? '/tasks';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 16, background: '#0b2545' }}>
        <Typography.Text strong style={{ color: '#fff', whiteSpace: 'nowrap' }}>{t('appName')}</Typography.Text>
        {screens.md ? (
          <Menu
            theme="dark"
            mode="horizontal"
            selectedKeys={[selected]}
            items={items}
            onClick={(e) => nav(e.key)}
            style={{ flex: 1, minWidth: 0, background: 'transparent' }}
          />
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <Space size={4}>
          {screens.md && <Typography.Text style={{ color: '#cfd8e3' }}>{session.user.name}</Typography.Text>}
          <Button size="small" onClick={() => setDelegateOpen(true)}>{screens.sm ? t('delegate') : '⇄'}</Button>
          <Button size="small" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'ع'}</Button>
          <Button size="small" onClick={() => { signOut(); force((n) => n + 1); }}>{t('signOut')}</Button>
        </Space>
      </Layout.Header>
      {!screens.md && (
        <Menu mode="horizontal" selectedKeys={[selected]} items={items} onClick={(e) => nav(e.key)} />
      )}
      <Layout.Content style={{ padding: 16, maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <Routes>
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/inspectables" element={<Inspectables />} />
          <Route path="/inspectables/:id" element={<InspectableDetail />} />
          <Route path="/inspections/:id" element={<InspectionDetail />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/team" element={<Team />} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Routes>
      </Layout.Content>
      <DelegateModal open={delegateOpen} onClose={() => setDelegateOpen(false)} />
    </Layout>
  );
}

function Themed() {
  const { lang } = useI18n();
  return (
    <ConfigProvider
      direction={lang === 'ar' ? 'rtl' : 'ltr'}
      locale={lang === 'ar' ? arEG : enUS}
      theme={{ token: { colorPrimary: '#13579b', borderRadius: 6, fontFamily: '"Noto Sans Arabic", "Segoe UI", system-ui, sans-serif' } }}
    >
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <Themed />
    </I18nProvider>
  </StrictMode>,
);
