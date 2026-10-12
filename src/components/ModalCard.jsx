import { useModalA11y } from '../hooks/useModalA11y'
// useModalA11y as a card element, for a dialog rendered inline inside a larger component (where the
// hook cannot be called conditionally). Mark the safe action with data-autofocus.
export default function ModalCard({ onCancel, initialFocusRef, children, ...rest }) {
  const a11y = useModalA11y({ onCancel, initialFocusRef })
  return <div {...rest} {...a11y}>{children}</div>
}
