import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import avatar from './assets/neko-avatar.webp'

/**
 * Render the Yingluo portrait at the host surface's requested size.
 * @param props - Host-supplied mark geometry.
 * @returns the decorative catgirl avatar.
 */
export function NekoBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img src={avatar} alt="" width={size} height={size} className={className} draggable={false} data-neko-avatar="" />
}

/**
 * Keep the sidebar avatar as its only brand artwork.
 * @returns No additional brand label.
 */
export function AvatarOnlyName(): null {
  return null
}
