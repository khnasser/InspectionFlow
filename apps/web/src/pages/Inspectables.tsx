import { Button, Card, Input, Table, Tag } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { date, useLoad } from '../hooks';
import { useI18n } from '../i18n';

export function Inspectables() {
  const { t, lang, i18n } = useI18n();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const { data, loading } = useLoad(() => api.get<any[]>(`/v1/inspectables?search=${encodeURIComponent(search)}`), [search]);
  return (
    <Card title={t('inspectables')} extra={<Input.Search allowClear placeholder={t('search')} onSearch={setSearch} style={{ width: 240 }} />}>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        scroll={{ x: 700 }}
        locale={{ emptyText: t('empty') }}
        columns={[
          { title: t('identifier'), dataIndex: 'identifier' },
          { title: t('name'), render: (_, r: any) => i18n(r.name_i18n, r.name) },
          { title: t('type'), dataIndex: 'type_code' },
          { title: t('log'), dataIndex: 'open_log', render: (v) => (v ? <Tag color="orange">{v}</Tag> : '-') },
          { title: t('lastInspected'), dataIndex: 'last_inspected_at', render: (v) => date(v, lang) },
          { title: '', render: (_, r: any) => <Button size="small" onClick={() => nav(`/inspectables/${r.id}`)}>{t('open')}</Button> },
        ]}
      />
    </Card>
  );
}
