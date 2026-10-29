import { Button, Card, Space, Switch, Table, Tag } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { date, notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

export function Tasks() {
  const { t, label, lang } = useI18n();
  const nav = useNavigate();
  const [includeDelegated, setIncludeDelegated] = useState(true);
  const { data, loading, reload } = useLoad(
    () => api.get<any[]>(`/v1/me/tasks?includeDelegated=${includeDelegated}`),
    [includeDelegated],
  );

  async function claim(id: string) {
    try {
      await api.post(`/v1/tasks/${id}/claim`);
      reload();
    } catch (e) {
      notifyError(e);
    }
  }

  function open(task: any) {
    if (task.task_type === 'INSPECT' && task.inspectable_id) {
      nav(`/inspectables/${task.inspectable_id}?inspect=${task.process_code}&task=${task.id}`);
    } else if (task.inspection_id) {
      nav(`/inspections/${task.inspection_id}`);
    }
  }

  return (
    <Card
      title={t('myTasks')}
      extra={
        <Space>
          <span>{t('includeDelegated')}</span>
          <Switch checked={includeDelegated} onChange={setIncludeDelegated} />
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        locale={{ emptyText: t('empty') }}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 760 }}
        columns={[
          {
            title: t('type'),
            dataIndex: 'task_type',
            render: (v, r: any) => (
              <Space size={4}>
                <Tag color={v === 'REVIEW' ? 'purple' : v === 'MORE_INFO' ? 'orange' : 'blue'}>{label(v)}</Tag>
                {r.via_delegation && <Tag color="gold">{t('delegate')}</Tag>}
              </Space>
            ),
          },
          { title: t('site'), render: (_, r: any) => (r.inspectable_name ? `${r.inspectable_name} (${r.identifier})` : '-') },
          { title: t('log'), dataIndex: 'log_number' },
          {
            title: t('due'),
            dataIndex: 'due_at',
            render: (v, r: any) => (
              <Space size={4}>
                {date(v, lang)}
                {r.overdue && <Tag color="red">{t('overdue')}</Tag>}
              </Space>
            ),
          },
          {
            title: '',
            render: (_, r: any) =>
              !r.assignee_id ? (
                <Button size="small" onClick={() => claim(r.id)}>
                  {t('claim')}
                </Button>
              ) : (
                <Button size="small" type="primary" onClick={() => open(r)}>
                  {r.task_type === 'INSPECT' ? t('inspect') : t('open')}
                </Button>
              ),
          },
        ]}
      />
    </Card>
  );
}
