export type SyncState = 'saved_on_phone' | 'sending' | 'sent' | 'failed' | 'waiting_connection';

export function syncLabelText(state: SyncState, willRetry = true): string {
  switch (state) {
    case 'saved_on_phone':
      return 'Saved on phone';
    case 'sending':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'failed':
      return willRetry ? 'Not sent, will retry' : 'Needs attention';
    case 'waiting_connection':
      return 'Waiting for connection';
  }
}
