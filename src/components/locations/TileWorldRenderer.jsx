import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import TileWorldScene from './TileWorldScene'

export default function TileWorldRenderer({ occupancy, width, height }) {
  const containerRef = useRef(null)
  const gameRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width,
      height,
      backgroundColor: 0xf5f3ee,
      scene: [TileWorldScene],
      audio: { noAudio: true },
      input: { mouse: false, touch: false, keyboard: false },
    })
    gameRef.current = game
    return () => {
      game.destroy(true)
      gameRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!gameRef.current || !occupancy) return
    const scene = gameRef.current.scene.getScene('TileWorld')
    if (scene) scene.events.emit('occupancy', occupancy)
  }, [occupancy])

  return <div ref={containerRef} style={{ width, height }} />
}
