import { Star } from 'lucide-react';

interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  size?: 'sm' | 'md';
}

/** Read-only when `onChange` is omitted (testimonial lists/cards); interactive (click to set 1-5) when provided (the submission form). */
export function StarRating({ value, onChange, size = 'md' }: StarRatingProps) {
  const dimension = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';
  return (
    <div className="inline-flex items-center gap-0.5" role={onChange ? 'radiogroup' : 'img'} aria-label={`${value} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((star) =>
        onChange ? (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={`${star} estrela${star > 1 ? 's' : ''}`}
            onClick={() => onChange(star)}
            className="rounded-sm transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Star className={`${dimension} ${star <= value ? 'fill-warn text-warn' : 'text-text-faint'}`} aria-hidden="true" />
          </button>
        ) : (
          <Star key={star} className={`${dimension} ${star <= value ? 'fill-warn text-warn' : 'text-text-faint'}`} aria-hidden="true" />
        ),
      )}
    </div>
  );
}
