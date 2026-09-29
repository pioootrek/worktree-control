export type DetailReturnTarget = {
  button: HTMLButtonElement;
  identity: string;
};

function visibleButton(button: HTMLButtonElement, scope: HTMLElement) {
  return scope.contains(button) && button.isConnected && !button.disabled
    && button.getClientRects().length > 0 && button.checkVisibility({ checkVisibilityCSS: true });
}

/** Restore focus to the same record after a detail sheet closes, even if its row was re-rendered. */
export function restoreDetailFocus(scope: HTMLElement | null, target: DetailReturnTarget | null) {
  if (!scope?.isConnected || !target) return;
  const button = visibleButton(target.button, scope) ? target.button
    : Array.from(scope.querySelectorAll<HTMLButtonElement>("button[data-detail-identity]"))
      .find((candidate) => candidate.dataset.detailIdentity === target.identity && visibleButton(candidate, scope));
  if (!button) {
    scope.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    return;
  }
  const rect = button.getBoundingClientRect();
  const onScreen = rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  button.focus({ preventScroll: onScreen });
}
