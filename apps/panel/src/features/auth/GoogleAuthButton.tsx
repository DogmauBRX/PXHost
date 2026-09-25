import { Button } from '@/ui/primitives';
import { loginWithGoogle } from './auth.api';

export function GoogleAuthButton({ label, redirectTo }: { label: string; redirectTo?: string }) {
  return (
    <>
      <div className="flex items-center gap-3 text-xs text-text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        ou continue com
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button type="button" variant="secondary" className="w-full" onClick={() => loginWithGoogle(redirectTo)}>
        <GoogleMark />
        {label}
      </Button>
    </>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" focusable="false">
      <path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.5a4.7 4.7 0 0 1-2 3.1v2.5h3.2c1.9-1.8 3.1-4.4 3.1-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.2-2.5c-.9.6-2 .9-3.5.9-2.7 0-5-1.8-5.8-4.3H2.9v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.2 13.7a6 6 0 0 1 0-3.4V7.7H2.9a10 10 0 0 0 0 8.6l3.3-2.6Z" />
      <path fill="#EA4335" d="M12 6a5.4 5.4 0 0 1 3.9 1.5l2.9-2.8A9.8 9.8 0 0 0 2.9 7.7l3.3 2.6C7 7.8 9.3 6 12 6Z" />
    </svg>
  );
}
