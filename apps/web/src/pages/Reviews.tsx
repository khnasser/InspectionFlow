import { Button, Card, Table, Tag } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { date, money, useLoad } from '../hooks';
import { useI18n } from '../i18n';

export function Reviews() {
  const { t, label, lang } = useI18n();
  const nav = useNavigate();
  const { data, loading } = useLoad(() => api.get<any[]>('/v1/reviews'));
  return (
    <Card title={t('reviews')}>
      <Table
        rowKey="approval_id"
        loading={loading}
        dataSource={data ?? []}
        locale={{ emptyText: t('empty') }}
        scroll={{ x: 760 }}
        columns={[
          { title: t('log'), dataIndex: 'log_number' },
          { title: t('site'), dataIndex: 'inspectable_name' },
          { title: t('inspector'), dataIndex: 'inspector' },
          { title: t('category'), dataIndex: 'category', render: (v) => <Tag color={v === 'PENALTY_CRITICAL' ? 'red' : 'orange'}>{label(v)}</Tag> },
          { title: t('totalFine'), dataIndex: 'total_fine', render: (v) => `${money(v, lang)} ${t('aed')}` },
          { title: t('chain'), dataIndex: 'approver_role', render: (v, r: any) => `${r.step_no}. ${label(v)}` },
          { title: t('due'), dataIndex: 'completed_at', render: (v) => date(v, lang) },
          {
            title: '',
            render: (_, r: any) => (
              <Button type="primary" size="small" onClick={() => nav(`/inspections/${r.inspection_id}`)}>
                {t('review')}
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
