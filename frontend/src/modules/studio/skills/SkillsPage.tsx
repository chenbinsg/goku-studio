import React, { useState } from 'react'
import { Space, Tabs, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

import SkillLibrary from './SkillLibrary'
import SkillList from './SkillList'

const { Title, Text } = Typography

/**
 * Skill 管理 — two pools, one direction.
 *
 * They are separate tabs rather than one filtered list because they are
 * genuinely separate things: a candidate in the Auto tab cannot be bound and is
 * never loaded by anything. The only crossing is 入库, which copies a candidate
 * into the library; afterwards the two rows are independent.
 */
const SkillsPage: React.FC = () => {
  const { t } = useTranslation()
  const [tab, setTab] = useState('library')

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 4 }} align="center">
        <ThunderboltOutlined style={{ fontSize: 24, color: '#1677ff' }} />
        <Title level={3} style={{ margin: 0 }}>
          {t('skills_page_title', 'Skill管理')}
        </Title>
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">
          {t('skills_page_subtitle',
            '正式Skill 才能被 agent 绑定和加载;自悟Skill 是系统自动提炼的候选,入库后才可用。')}
        </Text>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyInactiveTabPane={false}
        items={[
          {
            key: 'library',
            label: t('skills_tab_library', '正式Skill'),
            children: <SkillLibrary />,
          },
          {
            key: 'auto',
            label: t('skills_tab_auto', '自悟Skill'),
            children: <SkillList embedded />,
          },
        ]}
      />
    </div>
  )
}

export default SkillsPage
