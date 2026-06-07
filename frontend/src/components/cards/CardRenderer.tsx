import React from 'react'
import { Alert } from 'antd'
import type { CardMessage } from '../../types/card'
import TaskCard from './TaskCard'
import ToolExecutionCard from './ToolExecutionCard'
import ApprovalCard from './ApprovalCard'
import CodeCard from './CodeCard'
import TableCard from './TableCard'
import FormCard from './FormCard'
import ArticleCard from './ArticleCard'
import ImageGalleryCard from './ImageGalleryCard'
import VideoResultCard from './VideoResultCard'
import MusicPlayerCard from './MusicPlayerCard'
import VoicePlayerCard from './VoicePlayerCard'
import ProgramResultCard from './ProgramResultCard'

interface CardRendererProps {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const CARD_COMPONENTS: Record<string, React.FC<CardRendererProps>> = {
  task: TaskCard,
  tool_execution: ToolExecutionCard,
  approval: ApprovalCard,
  code: CodeCard,
  table: TableCard,
  form: FormCard,
  article: ArticleCard,
  image_gallery: ImageGalleryCard,
  video_result: VideoResultCard,
  music_result: MusicPlayerCard,
  voice_result: VoicePlayerCard,
  program_result: ProgramResultCard,
}

const CardRenderer: React.FC<CardRendererProps> = ({ card, onAction }) => {
  const Component = CARD_COMPONENTS[card.card_type]
  if (!Component) {
    return (
      <Alert
        type="warning"
        message={`Unknown card type: ${card.card_type}`}
        style={{ margin: '8px 0' }}
        showIcon
      />
    )
  }
  return <Component card={card} onAction={onAction} />
}

export default CardRenderer
