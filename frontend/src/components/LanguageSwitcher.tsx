import { Select } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { LANGUAGES, setLanguage, type LangCode } from '../i18n'

interface Props {
  style?: React.CSSProperties
}

const LanguageSwitcher: React.FC<Props> = ({ style }) => {
  const { i18n } = useTranslation()

  return (
    <Select
      value={i18n.language as LangCode}
      onChange={(lang) => setLanguage(lang)}
      style={{ width: 110, ...style }}
      size="small"
      suffixIcon={<GlobalOutlined />}
      options={LANGUAGES.map((l) => ({ value: l.code, label: l.nativeLabel }))}
      variant="borderless"
    />
  )
}

export default LanguageSwitcher
