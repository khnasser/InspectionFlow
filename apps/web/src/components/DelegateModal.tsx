import { DatePicker, Form, Input, Modal, Select, message } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { api, session } from '../api';
import { notifyError, useLoad } from '../hooks';
import { useI18n } from '../i18n';

/** PRD 3.7 — "تفويض المهام": hand my tasks to a colleague for a period (leave, absence). */
export function DelegateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [form] = Form.useForm();
  const { data: users } = useLoad(() => (open ? api.get<any[]>('/v1/users') : Promise.resolve([])), [open]);

  async function save() {
    const v = await form.validateFields();
    const [start, end] = v.period as [Dayjs, Dayjs];
    try {
      await api.post('/v1/delegations', {
        delegateId: v.delegateId,
        startsAt: start.startOf('day').toISOString(),
        endsAt: end.endOf('day').toISOString(),
        reason: v.reason,
      });
      message.success(t('done'));
      onClose();
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <Modal open={open} title={t('delegate')} onOk={save} onCancel={onClose} okText={t('save')} cancelText={t('cancel')} destroyOnClose>
      <Form form={form} layout="vertical" initialValues={{ period: [dayjs(), dayjs().add(7, 'day')] }}>
        <Form.Item name="delegateId" label={t('delegateTo')} rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="label"
            options={(users ?? [])
              .filter((u: any) => u.id !== session.user?.userId)
              .map((u: any) => ({ value: u.id, label: u.display_name }))}
          />
        </Form.Item>
        <Form.Item name="period" label={t('period')} rules={[{ required: true }]}>
          <DatePicker.RangePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="reason" label={t('reason')}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
