// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmModal } from '../../../src/renderer/src/components/ConfirmModal'
import { useStore } from '../../../src/renderer/src/store'
import { setupRenderer } from '../helpers'

beforeEach(() => setupRenderer())

describe('ConfirmModal', () => {
  it('renders nothing without a pending request', () => {
    const { container } = render(<ConfirmModal />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the message and confirms with true', () => {
    const onResolve = vi.fn()
    useStore.setState({ confirmRequest: { message: 'Delete it?', onResolve } })
    render(<ConfirmModal />)
    expect(screen.getByText('Delete it?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Підтвердити'))
    expect(onResolve).toHaveBeenCalledWith(true)
    expect(useStore.getState().confirmRequest).toBeNull()
  })

  it('cancels with false', () => {
    const onResolve = vi.fn()
    useStore.setState({ confirmRequest: { message: 'Delete it?', onResolve } })
    render(<ConfirmModal />)
    fireEvent.click(screen.getByText('Скасувати'))
    expect(onResolve).toHaveBeenCalledWith(false)
  })
})
