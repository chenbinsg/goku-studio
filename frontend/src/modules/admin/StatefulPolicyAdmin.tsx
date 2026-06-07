import { useEffect, useState, useCallback } from "react";
import {
  Button, Table, Tag, Modal, Form, Input, Select, Popconfirm,
  message, Space, Typography, Tooltip, Badge,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  QuestionCircleOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { api } from "@/api";

const { Title, Text } = Typography;

const MODES = [
  { value: "auto",              label: "Auto",              color: "green",  desc: "Execute immediately, no confirmation" },
  { value: "confirm_required",  label: "Confirm Required",  color: "blue",   desc: "Agent pauses and asks user to confirm" },
  { value: "approval_required", label: "Approval Required", color: "orange", desc: "Requires an approval workflow to complete" },
  { value: "human_only",        label: "Human Only",        color: "red",    desc: "Cannot be executed by agent — human must act" },
];

const modeInfo = Object.fromEntries(MODES.map((m) => [m.value, m]));

interface Policy {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  entity_kind: string;
  action_name: string;
  policy_mode: string;
  allow_idempotent_retry: boolean;
  reason: string | null;
  created_by: string | null;
  updated_at: string | null;
}

interface Kind {
  kind: string;
  display_name: string;
  description: string;
}

export default function StatefulPolicyAdmin() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [form] = Form.useForm();

  const [filterKind, setFilterKind] = useState<string | undefined>(undefined);

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterKind) params.entity_kind = filterKind;
      const res = await api.get<any>("/stateful-policies", { params });
      setPolicies(res.items || []);
    } catch {
      message.error("Failed to load policies");
    } finally {
      setLoading(false);
    }
  }, [filterKind]);

  const fetchKinds = useCallback(async () => {
    try {
      const res = await api.get<any>("/stateful-policies/meta/kinds");
      setKinds(res.kinds || []);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
    fetchKinds();
  }, [fetchPolicies, fetchKinds]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (row: Policy) => {
    setEditing(row);
    form.setFieldsValue({
      entity_kind: row.entity_kind,
      action_name: row.action_name,
      policy_mode: row.policy_mode,
      reason: row.reason ?? "",
      tenant_id: row.tenant_id ?? "",
      agent_id: row.agent_id ?? "",
      allow_idempotent_retry: row.allow_idempotent_retry ?? false,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await api.put(`/stateful-policies/${editing.id}`, {
          policy_mode: values.policy_mode,
          reason: values.reason || null,
          agent_id: values.agent_id || null,
          allow_idempotent_retry: values.allow_idempotent_retry ?? false,
        });
        message.success("Policy updated");
      } else {
        await api.post("/stateful-policies", {
          entity_kind: values.entity_kind,
          action_name: values.action_name,
          policy_mode: values.policy_mode,
          reason: values.reason || null,
          tenant_id: values.tenant_id || null,
          agent_id: values.agent_id || null,
          allow_idempotent_retry: values.allow_idempotent_retry ?? false,
        });
        message.success("Policy created");
      }
      setModalOpen(false);
      fetchPolicies();
    } catch (err: any) {
      message.error(err?.response?.data?.detail || "Save failed");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/stateful-policies/${id}`);
      message.success("Policy deleted");
      fetchPolicies();
    } catch {
      message.error("Delete failed");
    }
  };

  const columns = [
    {
      title: "Kind",
      dataIndex: "entity_kind",
      key: "entity_kind",
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: "Action",
      dataIndex: "action_name",
      key: "action_name",
      render: (v: string) => (
        v === "*"
          ? <Tag color="purple">* (all actions)</Tag>
          : <code>{v}</code>
      ),
    },
    {
      title: "Policy Mode",
      dataIndex: "policy_mode",
      key: "policy_mode",
      render: (v: string) => {
        const info = modeInfo[v];
        return info
          ? <Tag color={info.color}>{info.label}</Tag>
          : <Tag>{v}</Tag>;
      },
    },
    {
      title: "Scope",
      key: "scope",
      render: (_: unknown, row: Policy) => (
        <Space direction="vertical" size={2}>
          {row.tenant_id
            ? <Text type="secondary" style={{ fontSize: 11 }}>tenant: {row.tenant_id}</Text>
            : <Badge status="processing" text="Global" />}
          {row.agent_id
            ? <Text type="secondary" style={{ fontSize: 11 }}>agent: {row.agent_id}</Text>
            : null}
        </Space>
      ),
    },
    {
      title: "Retry",
      dataIndex: "allow_idempotent_retry",
      key: "allow_idempotent_retry",
      render: (v: boolean) => v
        ? <Tag color="green">Allow</Tag>
        : <Tag color="default">Block</Tag>,
    },
    {
      title: "Reason",
      dataIndex: "reason",
      key: "reason",
      render: (v: string | null) =>
        v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : "—",
    },
    {
      title: "Updated",
      dataIndex: "updated_at",
      key: "updated_at",
      render: (v: string | null) =>
        v ? new Date(v).toLocaleString() : "—",
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, row: Policy) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(row)}
          >
            Edit
          </Button>
          <Popconfirm
            title="Delete this policy?"
            onConfirm={() => handleDelete(row.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: "24px 32px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Stateful Action Policies</Title>
          <Text type="secondary">
            Override the default execution policy for stateful business actions.
            Tenant-specific policies take priority over global ones.
          </Text>
        </div>
        <Space>
          <Select
            placeholder="Filter by kind"
            allowClear
            style={{ width: 180 }}
            value={filterKind}
            onChange={setFilterKind}
            options={kinds.map((k) => ({ value: k.kind, label: k.display_name || k.kind }))}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchPolicies}>Refresh</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Policy
          </Button>
        </Space>
      </div>

      {/* Policy mode legend */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {MODES.map((m) => (
          <Tooltip key={m.value} title={m.desc}>
            <Tag color={m.color} style={{ cursor: "help" }}>
              {m.label} <QuestionCircleOutlined style={{ opacity: 0.6 }} />
            </Tag>
          </Tooltip>
        ))}
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={policies}
        columns={columns}
        pagination={{ pageSize: 20 }}
        size="small"
      />

      <Modal
        title={editing ? "Edit Policy" : "Create Policy"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText={editing ? "Save" : "Create"}
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="entity_kind"
            label="Entity Kind"
            rules={[{ required: true }]}
          >
            <Select
              disabled={!!editing}
              placeholder="e.g. approval, ticket"
              options={kinds.map((k) => ({
                value: k.kind,
                label: `${k.display_name || k.kind}`,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="action_name"
            label={
              <span>
                Action Name{" "}
                <Tooltip title='Use * to match all actions in this kind'>
                  <QuestionCircleOutlined style={{ opacity: 0.5 }} />
                </Tooltip>
              </span>
            }
            rules={[{ required: true, message: "Enter an action name or *" }]}
          >
            <Input disabled={!!editing} placeholder="e.g. approve, submit, * (all)" />
          </Form.Item>

          <Form.Item name="policy_mode" label="Policy Mode" rules={[{ required: true }]}>
            <Select
              options={MODES.map((m) => ({
                value: m.value,
                label: (
                  <span>
                    <Tag color={m.color} style={{ marginRight: 6 }}>{m.label}</Tag>
                    <span style={{ fontSize: 12, color: "#888" }}>{m.desc}</span>
                  </span>
                ),
              }))}
            />
          </Form.Item>

          <Form.Item name="tenant_id" label="Tenant ID (leave blank for global)">
            <Input placeholder="Global policy if blank" disabled={!!editing} />
          </Form.Item>

          <Form.Item
            name="agent_id"
            label={
              <span>
                Agent ID (leave blank for all agents){" "}
                <Tooltip title="Restrict this policy to a specific agent. Agent+tenant-specific policies take highest priority.">
                  <QuestionCircleOutlined style={{ opacity: 0.5 }} />
                </Tooltip>
              </span>
            }
          >
            <Input placeholder="Agent UUID — blank applies to all agents" />
          </Form.Item>

          <Form.Item
            name="allow_idempotent_retry"
            label={
              <span>
                Allow non-idempotent retry{" "}
                <Tooltip title="When enabled, the stateful runtime will re-execute non-idempotent actions if they appear in the step history. Disabled by default (safe/conservative).">
                  <QuestionCircleOutlined style={{ opacity: 0.5 }} />
                </Tooltip>
              </span>
            }
            valuePropName="checked"
            initialValue={false}
          >
            <Select
              options={[
                { value: false, label: "Block (safe default)" },
                { value: true,  label: "Allow retry" },
              ]}
            />
          </Form.Item>

          <Form.Item name="reason" label="Admin Note">
            <Input.TextArea rows={2} placeholder="Why this override was set" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
