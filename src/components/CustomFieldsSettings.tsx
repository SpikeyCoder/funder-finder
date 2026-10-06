// FM-IC-CFG-001: settings panel where a user DEFINES custom data fields for
// their funders and opportunities (the "custom-field schema" the usability
// audit flagged as missing). Field definitions drive the value inputs shown
// on the SavedFunders pipeline cards and the opportunity editor.
import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { slugifyFieldKey } from '../lib/customFields';
import type {
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomFieldType,
} from '../types';

const FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link (URL)' },
];

const ENTITIES: { value: CustomFieldEntity; label: string; hint: string }[] = [
  { value: 'funder', label: 'Funders', hint: 'Shown on your saved funders' },
  { value: 'grant', label: 'Opportunities', hint: 'Shown on tracked grants' },
];

export default function CustomFieldsSettings() {
  const { user } = useAuth();
  const [entity, setEntity] = useState<CustomFieldEntity>('funder');
  const [defs, setDefs] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // new-field form
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');

  const load = async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const { data, error: e } = await supabase
        .from('custom_field_definitions')
        .select('*')
        .eq('entity', entity)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (e) throw e;
      setDefs((data ?? []).map((row: any) => ({
        ...row,
        options: Array.isArray(row.options) ? row.options : [],
      })) as CustomFieldDefinition[]);
    } catch (e: any) {
      console.error('Failed to load custom fields:', e);
      setError('Could not load custom fields.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user, entity]);

  const addField = async () => {
    if (!user || !label.trim()) return;
    setSaving(true);
    setError('');
    try {
      const options = fieldType === 'select'
        ? optionsText.split('\n').map(o => o.trim()).filter(Boolean)
        : [];
      // ensure a unique field_key within this entity
      const base = slugifyFieldKey(label);
      const existing = new Set(defs.map(d => d.field_key));
      let key = base;
      let i = 2;
      while (existing.has(key)) { key = `${base}_${i++}`; }

      const { error: e } = await supabase
        .from('custom_field_definitions')
        .insert({
          user_id: user.id,
          entity,
          field_key: key,
          label: label.trim(),
          field_type: fieldType,
          options,
          sort_order: defs.length,
        });
      if (e) throw e;
      setLabel('');
      setFieldType('text');
      setOptionsText('');
      await load();
    } catch (e: any) {
      console.error('Failed to add custom field:', e);
      setError('Could not add the field. Field names must be unique.');
    } finally {
      setSaving(false);
    }
  };

  const removeField = async (id: string) => {
    setError('');
    try {
      const { error: e } = await supabase
        .from('custom_field_definitions')
        .delete()
        .eq('id', id);
      if (e) throw e;
      setDefs(prev => prev.filter(d => d.id !== id));
    } catch (e: any) {
      console.error('Failed to delete custom field:', e);
      setError('Could not delete the field.');
    }
  };

  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-1">Custom fields</h2>
      <p className="text-sm text-gray-400 mb-4">
        Add your own data fields to funders and opportunities — anything the
        built-in columns don&apos;t cover, like a program officer, internal
        priority, or board champion.
      </p>

      {/* Entity switcher */}
      <div className="flex gap-2 mb-5">
        {ENTITIES.map(en => (
          <button
            key={en.value}
            onClick={() => setEntity(en.value)}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              entity === en.value
                ? 'bg-blue-900/40 border-blue-600 text-white'
                : 'bg-gray-800/40 border-gray-700 text-gray-300 hover:text-white'
            }`}
            title={en.hint}
          >
            {en.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {/* Existing fields */}
      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Loader2 className="animate-spin" size={16} /> Loading…
        </div>
      ) : defs.length === 0 ? (
        <p className="text-sm text-gray-500 italic mb-4">No custom fields yet.</p>
      ) : (
        <ul className="space-y-2 mb-5">
          {defs.map(def => (
            <li
              key={def.id}
              className="flex items-center justify-between bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5"
            >
              <div>
                <span className="text-sm text-white font-medium">{def.label}</span>
                <span className="ml-2 text-xs text-gray-500">
                  {FIELD_TYPES.find(t => t.value === def.field_type)?.label}
                  {def.field_type === 'select' && def.options.length > 0
                    ? ` · ${def.options.length} options`
                    : ''}
                </span>
              </div>
              <button
                onClick={() => removeField(def.id)}
                aria-label={`Delete custom field ${def.label}`}
                className="text-gray-500 hover:text-red-400 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add new field */}
      <div className="border-t border-[#30363d] pt-4">
        <h3 className="text-sm font-semibold text-white mb-3">Add a field</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="cf-new-label" className="text-xs text-gray-400">Field name</label>
            <input
              id="cf-new-label"
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Program Officer"
              className="rounded-md bg-gray-800 border border-gray-600 px-2 py-1.5 text-sm text-white"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cf-new-type" className="text-xs text-gray-400">Type</label>
            <select
              id="cf-new-type"
              value={fieldType}
              onChange={e => setFieldType(e.target.value as CustomFieldType)}
              className="rounded-md bg-gray-800 border border-gray-600 px-2 py-1.5 text-sm text-white"
            >
              {FIELD_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        {fieldType === 'select' && (
          <div className="flex flex-col gap-1 mt-3">
            <label htmlFor="cf-new-options" className="text-xs text-gray-400">
              Options (one per line)
            </label>
            <textarea
              id="cf-new-options"
              rows={3}
              value={optionsText}
              onChange={e => setOptionsText(e.target.value)}
              placeholder={'High\nMedium\nLow'}
              className="rounded-md bg-gray-800 border border-gray-600 px-2 py-1.5 text-sm text-white resize-none"
            />
          </div>
        )}

        <button
          onClick={addField}
          disabled={saving || !label.trim()}
          className="mt-3 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl px-4 py-2 text-sm transition-colors"
        >
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
          Add field
        </button>
      </div>
    </div>
  );
}
