import React, { useState } from 'react'
import { Card, Form, Input, Select, DatePicker, Radio, Checkbox, InputNumber, Button, Typography, Space } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, FormCardData, FormField } from '../../types/card'

const { Text } = Typography

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const FormCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as FormCardData
  const [form] = Form.useForm()
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setSubmitted(true)
      onAction(card.card_id, 'submit', { task_id: data.task_id, values })
    } catch {
      // validation failed
    }
  }

  const renderField = (field: FormField) => {
    switch (field.type) {
      case 'text':
        return <Input placeholder={field.placeholder} />
      case 'textarea':
        return <Input.TextArea rows={3} placeholder={field.placeholder} />
      case 'number':
        return <InputNumber style={{ width: '100%' }} placeholder={field.placeholder} />
      case 'select':
        return <Select options={field.options} placeholder={field.placeholder} />
      case 'date':
        return <DatePicker style={{ width: '100%' }} />
      case 'radio':
        return <Radio.Group options={field.options} />
      case 'checkbox':
        return <Checkbox.Group options={field.options} />
      default:
        return <Input placeholder={field.placeholder} />
    }
  }

  return (
    <Card
      size="small"
      style={{ margin: '8px 0', borderLeft: '3px solid #1890ff', opacity: submitted ? 0.7 : 1 }}
    >
      <Space style={{ marginBottom: 8 }}>
        <RobotOutlined style={{ color: '#1890ff' }} />
        <Text strong>{data.title}</Text>
      </Space>

      <Form
        form={form}
        layout="vertical"
        size="small"
        disabled={submitted}
        initialValues={
          Object.fromEntries(data.fields.filter((f) => f.default_value != null).map((f) => [f.name, f.default_value]))
        }
      >
        {data.fields.map((field) => (
          <Form.Item
            key={field.name}
            name={field.name}
            label={field.label}
            rules={field.required ? [{ required: true, message: t('form_card_required_message', { field_label: field.label }) }] : undefined}
          >
            {renderField(field)}
          </Form.Item>
        ))}
      </Form>

      {!submitted ? (
        <Button type="primary" size="small" onClick={handleSubmit}>
          {t('form_card_submit_button')}
        </Button>
      ) : (
        <Text type="success" style={{ fontSize: 12 }}>{t('form_card_submitted_status')}</Text>
      )}
    </Card>
  )
}

export default FormCard
