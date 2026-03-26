import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, Loader2 } from 'lucide-react';

// Minimal type declarations for the Google Maps Places API (loaded at runtime)
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace google.maps.places {
  class AutocompleteService {
    getPlacePredictions(
      request: { input: string; types?: string[] },
      callback: (predictions: AutocompletePrediction[] | null, status: string) => void,
    ): void;
  }
  interface AutocompletePrediction {
    description: string;
    place_id: string;
  }
  const PlacesServiceStatus: { OK: string };
}

/**
 * LocationAutocomplete — Google Places-powered location search.
 *
 * Falls back to a curated local suggestion list when the Google Maps script
 * hasn't loaded (e.g. missing API key or blocked by browser).
 *
 * The component loads the Google Maps JS SDK lazily on first focus so it
 * doesn't block the initial page render.
 */

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Curated fallback suggestions when Google Maps isn't available
const FALLBACK_LOCATIONS: { label: string; type: string }[] = [
  { label: 'National (United States)', type: 'scope' },
  { label: 'International / Global', type: 'scope' },
  { label: 'New York, NY', type: 'city' },
  { label: 'Los Angeles, CA', type: 'city' },
  { label: 'Chicago, IL', type: 'city' },
  { label: 'Houston, TX', type: 'city' },
  { label: 'Phoenix, AZ', type: 'city' },
  { label: 'Philadelphia, PA', type: 'city' },
  { label: 'San Antonio, TX', type: 'city' },
  { label: 'San Diego, CA', type: 'city' },
  { label: 'Dallas, TX', type: 'city' },
  { label: 'Seattle, WA', type: 'city' },
  { label: 'Denver, CO', type: 'city' },
  { label: 'Boston, MA', type: 'city' },
  { label: 'Atlanta, GA', type: 'city' },
  { label: 'Miami, FL', type: 'city' },
  { label: 'Portland, OR', type: 'city' },
  { label: 'Minneapolis, MN', type: 'city' },
  { label: 'Detroit, MI', type: 'city' },
  { label: 'Nashville, TN', type: 'city' },
  { label: 'Charlotte, NC', type: 'city' },
  { label: 'San Francisco, CA', type: 'city' },
  { label: 'Washington, DC', type: 'city' },
  { label: 'Austin, TX', type: 'city' },
  { label: 'Alabama', type: 'state' },
  { label: 'Alaska', type: 'state' },
  { label: 'Arizona', type: 'state' },
  { label: 'Arkansas', type: 'state' },
  { label: 'California', type: 'state' },
  { label: 'Colorado', type: 'state' },
  { label: 'Connecticut', type: 'state' },
  { label: 'Delaware', type: 'state' },
  { label: 'Florida', type: 'state' },
  { label: 'Georgia', type: 'state' },
  { label: 'Hawaii', type: 'state' },
  { label: 'Idaho', type: 'state' },
  { label: 'Illinois', type: 'state' },
  { label: 'Indiana', type: 'state' },
  { label: 'Iowa', type: 'state' },
  { label: 'Kansas', type: 'state' },
  { label: 'Kentucky', type: 'state' },
  { label: 'Louisiana', type: 'state' },
  { label: 'Maine', type: 'state' },
  { label: 'Maryland', type: 'state' },
  { label: 'Massachusetts', type: 'state' },
  { label: 'Michigan', type: 'state' },
  { label: 'Minnesota', type: 'state' },
  { label: 'Mississippi', type: 'state' },
  { label: 'Missouri', type: 'state' },
  { label: 'Montana', type: 'state' },
  { label: 'Nebraska', type: 'state' },
  { label: 'Nevada', type: 'state' },
  { label: 'New Hampshire', type: 'state' },
  { label: 'New Jersey', type: 'state' },
  { label: 'New Mexico', type: 'state' },
  { label: 'New York', type: 'state' },
  { label: 'North Carolina', type: 'state' },
  { label: 'North Dakota', type: 'state' },
  { label: 'Ohio', type: 'state' },
  { label: 'Oklahoma', type: 'state' },
  { label: 'Oregon', type: 'state' },
  { label: 'Pennsylvania', type: 'state' },
  { label: 'Rhode Island', type: 'state' },
  { label: 'South Carolina', type: 'state' },
  { label: 'South Dakota', type: 'state' },
  { label: 'Tennessee', type: 'state' },
  { label: 'Texas', type: 'state' },
  { label: 'Utah', type: 'state' },
  { label: 'Vermont', type: 'state' },
  { label: 'Virginia', type: 'state' },
  { label: 'Washington', type: 'state' },
  { label: 'West Virginia', type: 'state' },
  { label: 'Wisconsin', type: 'state' },
  { label: 'Wyoming', type: 'state' },
  { label: 'King County, WA', type: 'county' },
  { label: 'Cook County, IL', type: 'county' },
  { label: 'Harris County, TX', type: 'county' },
  { label: 'Maricopa County, AZ', type: 'county' },
  { label: 'San Diego County, CA', type: 'county' },
  { label: 'Northeast United States', type: 'region' },
  { label: 'Southeast United States', type: 'region' },
  { label: 'Midwest United States', type: 'region' },
  { label: 'Southwest United States', type: 'region' },
  { label: 'Pacific Northwest', type: 'region' },
  { label: 'Appalachia', type: 'region' },
  { label: 'Rural communities', type: 'scope' },
  { label: 'Tribal Nations', type: 'scope' },
  { label: 'Sub-Saharan Africa', type: 'international' },
  { label: 'Latin America', type: 'international' },
  { label: 'Southeast Asia', type: 'international' },
  { label: 'Eastern Europe', type: 'international' },
  { label: 'Middle East & North Africa', type: 'international' },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  hasError?: boolean;
  placeholder?: string;
}

// Track Google Maps script loading state globally
let googleMapsLoading = false;
let googleMapsLoaded = false;
const googleMapsCallbacks: (() => void)[] = [];

function loadGoogleMaps(): Promise<void> {
  if (googleMapsLoaded) return Promise.resolve();
  if (!GOOGLE_MAPS_API_KEY) return Promise.reject(new Error('No API key'));

  return new Promise((resolve, reject) => {
    if (googleMapsLoading) {
      googleMapsCallbacks.push(resolve);
      return;
    }
    googleMapsLoading = true;
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
    script.async = true;
    script.onload = () => {
      googleMapsLoaded = true;
      googleMapsLoading = false;
      resolve();
      googleMapsCallbacks.forEach(cb => cb());
      googleMapsCallbacks.length = 0;
    };
    script.onerror = () => {
      googleMapsLoading = false;
      reject(new Error('Failed to load Google Maps'));
    };
    document.head.appendChild(script);
  });
}

export default function LocationAutocomplete({ value, onChange, hasError, placeholder }: Props) {
  const [suggestions, setSuggestions] = useState<{ label: string; placeId?: string; type: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [useGoogle, setUseGoogle] = useState(false);
  const autocompleteService = useRef<google.maps.places.AutocompleteService | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Try to load Google Maps on first focus
  const handleFocus = useCallback(() => {
    setOpen(true);
    if (!useGoogle && GOOGLE_MAPS_API_KEY && !googleMapsLoaded) {
      loadGoogleMaps()
        .then(() => {
          autocompleteService.current = new google.maps.places.AutocompleteService();
          setUseGoogle(true);
        })
        .catch(() => {
          // Fall back to local suggestions
        });
    }
  }, [useGoogle]);

  // Google Places autocomplete
  const fetchGoogleSuggestions = useCallback((input: string) => {
    if (!autocompleteService.current || !input.trim()) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    autocompleteService.current.getPlacePredictions(
      {
        input,
        types: ['(regions)'], // cities, counties, states, countries
      },
      (predictions, status) => {
        setLoading(false);
        if (status === google.maps.places.PlacesServiceStatus.OK && predictions) {
          setSuggestions(
            predictions.map(p => ({
              label: p.description,
              placeId: p.place_id,
              type: 'google',
            }))
          );
        } else {
          setSuggestions([]);
        }
      }
    );
  }, []);

  // Local fuzzy matching fallback
  const fetchLocalSuggestions = useCallback((input: string) => {
    const query = input.toLowerCase().trim();
    if (!query) {
      // Show popular suggestions when empty
      setSuggestions(FALLBACK_LOCATIONS.filter(l =>
        l.type === 'scope' || l.type === 'region'
      ).slice(0, 8));
      return;
    }
    const matches = FALLBACK_LOCATIONS.filter(l =>
      l.label.toLowerCase().includes(query)
    ).slice(0, 8);
    setSuggestions(matches);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      if (useGoogle && GOOGLE_MAPS_API_KEY) {
        fetchGoogleSuggestions(value);
      } else {
        fetchLocalSuggestions(value);
      }
    }, useGoogle ? 300 : 100);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, open, useGoogle, fetchGoogleSuggestions, fetchLocalSuggestions]);

  const selectSuggestion = (label: string) => {
    onChange(label);
    setOpen(false);
    setSuggestions([]);
  };

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          value={value}
          onChange={e => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={handleFocus}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder={placeholder || 'e.g. King County, WA | Chicago, IL | National'}
          className={`w-full bg-[#0d1117] border rounded-xl px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${hasError ? 'border-red-500' : 'border-[#30363d]'}`}
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Loader2 size={16} className="animate-spin text-gray-500" />
          </div>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-20 w-full mt-1 bg-[#21262d] border border-[#30363d] rounded-xl overflow-hidden shadow-xl max-h-64 overflow-y-auto">
          {suggestions.map((suggestion, i) => (
            <button
              key={`${suggestion.label}-${i}`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(suggestion.label);
              }}
              className="flex items-center gap-2.5 w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-[#30363d] transition-colors"
            >
              <MapPin size={13} className="text-blue-400 shrink-0" />
              <span>{suggestion.label}</span>
              {suggestion.type !== 'google' && suggestion.type !== 'city' && suggestion.type !== 'county' && (
                <span className="ml-auto text-[10px] text-gray-600 uppercase">{suggestion.type}</span>
              )}
            </button>
          ))}
          {useGoogle && (
            <div className="px-4 py-1.5 text-[10px] text-gray-600 border-t border-[#30363d]">
              Powered by Google
            </div>
          )}
        </div>
      )}
    </div>
  );
}
