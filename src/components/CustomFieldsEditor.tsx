// FM-IC-CFG-001: inline editor for user-defined custom field VALUES.
// Renders one input per definition for a given entity, and reports changes
// up to the parent (which persists them). Used on the SavedFunders pipeline
// cards so users can capture their own structured data (e.g. "Program
// Officer", "Internal Priority") beyond the fixed columns + notes.
import { useEffect, useState } from 'react';
import type {
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomFieldValue,
} from '../types';
import {
  fetchCustomFieldDefinitions,
  coerceFieldValue,
} from '../lib/customFields';

interface Props {
  entity: CustomFieldEntity;
  values: Record<string, CustomFieldValue>;
  onChange: (next: Record<string, CustomFieldValue>) => void;
  /** Pre-loaded definitions; if omitted the component fetches them itself. */
  definitions?: CustomFieldDefinition[];
}

export default function CustomFieldsEditor({ entity, values, onChange, definitions }: Props) {
  const [defs, setDefs] = useState<CustomFieldDefinition[]>(definitions ?? []);
  const [loading, setLoading] = useState(!definitions);

  useEffect(() => {
    if (definitions) {
      setDefs(definitions);
      return;
    }
    let cancelled = false;
    fetchCustomFieldDefinitions(entity)
      .then((d) => { if (!cancelled) setDefs(d); })
      .catch((e) => console.error('Failed to load custom fields:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entity, definitions]);

  if (loading) return null;
  if (defs.length === 0) return null;

  const setValue = (key: string, value: CustomFieldValue) => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {defs.map((def) => {
        const current = values[def.field_key];
        const inputId = `cf-${entity}-${def.id}`;
        return (
          <div key={def.id} className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-xs font-medium text-gray-300">
              {def.label}
            </label>
            {def.field_type === 'select' ? (
              <select
                id={inputId}
                value={current == null ? '' : String(current)}
                onChange={(e) => setValue(def.field_key, coerceFieldValue('select', e.target.value))}
                className="rounded-md bg-gray-800 border border-gray-600 px-2 py-1 text-sm text-white"
              >
                <option value="">—</option>
                {def.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : def.field_type === 'checkbox' ? (
              <input
                id={inputId}
                type="checkbox"
                checked={Boolean(current)}
                onChange={(e) => setValue(def.field_key, coerceFieldValue('checkbox', e.target.checked))}
                className="h-4 w-4 rounded border-gray-600 bg-gray-800"
              />
            ) : (
              <input
                id={inputId}
                type={def.field_type === 'number' ? 'number' : def.field_type === 'date' ? 'date' : def.field_type === 'url' ? 'url' : 'text'}
                value={current == null ? '' : String(current)}
                onChange={(e) => setValue(def.field_key, coerceFieldValue(def.field_type, e.target.value))}
                className="rounded-md bg-gray-800 border border-gray-600 px-2 py-1 text-sm text-white"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
