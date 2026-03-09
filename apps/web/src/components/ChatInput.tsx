/**
 * Chat input component — simple text input for sending messages.
 * A minimal version of the Electron renderer's FreeFormInput.
 */

import { useState, useRef, useCallback } from 'react'

interface ChatInputProps {
  onSend: (message: string) => void
  onCancel: () => void
  isProcessing: boolean
  disabled: boolean
}

export function ChatInput({ onSend, onCancel, isProcessing, disabled }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isProcessing) return
      handleSend()
    }
  }, [handleSend, isProcessing])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    // Auto-resize
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
  }, [])

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={isProcessing ? 'Agent is working...' : 'Send a message... (Enter to send, Shift+Enter for newline)'}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none px-3 py-2 rounded-md border border-border bg-foreground-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-muted-foreground disabled:opacity-50"
          style={{ maxHeight: 200 }}
        />
        {isProcessing ? (
          <button
            onClick={onCancel}
            className="shrink-0 px-4 py-2 rounded-md bg-destructive text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className="shrink-0 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
