import { Button, Card, Table, Tag, Typography, message } from 'antd';
import { api } from '../api';
import { date, money, notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

export function Payments() {
  const { t, label, lang } = useI18n();
  const { data, loading } = useLoad(() => api.get<any[]>('/v1/payment-advices'));

  async function link(id: string) {
    try {
      const r = await api.post<{ url: string }>(`/v1/payment-advices/${id}/pay-link`);
      await navigator.clipboard?.writeText(r.url).catch(() => undefined);
      message.success(r.url);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <Card title={t('payments')}>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        scroll={{ x: 760 }}
        locale={{ emptyText: t('empty') }}
        columns={[
          { title: t('number'), dataIndex: 'pa_number', render: (v) => <Typography.Text code>{v}</Typography.Text> },
          { title: t('party'), dataIndex: 'party_name' },
          { title: t('log'), dataIndex: 'log_number' },
          { title: t('amount'), dataIndex: 'amount', render: (v) => `${money(v, lang)} ${t('aed')}` },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (v, r: any) => (
              <>
                <Tag color={v === 'PAID' ? 'green' : 'blue'}>{label(v)}</Tag>
                {r.overdue && <Tag color="red">{t('overdue')}</Tag>}
              </>
            ),
          },
          { title: t('due'), dataIndex: 'due_at', render: (v) => date(v, lang) },
          {
            title: '',
            render: (_, r: any) =>
              r.status !== 'PAID' ? <Button size="small" onClick={() => link(r.id)}>{t('payLink')}</Button> : date(r.paid_at, lang),
          },
        ]}
      />
    </Card>
  );
}
