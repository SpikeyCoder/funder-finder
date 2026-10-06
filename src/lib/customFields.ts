// FM-IC-CFG-001: client helpers for user-defined custom data fields.
import { supabase } from './supabase';
import type {
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomFieldValue,
} from '../types';

/** Fetch the current user's custom field definitions for a given entity. */
export async function fetchCustomFieldDefinitions(
  entity: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  const { data, error } = await supabase
    .from('custom_field_definitions')
    .select('*')
    .eq('entity', entity)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    ...row,
    options: Array.isArray(row.options) ? row.options : [],
  })) as CustomFieldDefinition[];
}

/** Derive a URL/identifier-safe field_key from a human label. */
export function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'field';
}

/** Coerce a raw input string into the typed value for a field. */
export function coerceFieldValue(
  type: CustomFieldDefinition['field_type'],
  raw: string | boolean,
): CustomFieldValue {
  if (type === 'checkbox') return Boolean(raw);
  const str = String(raw);
  if (str === '') return null;
  if (type === 'number') {
    const n = Number(str);
    return Number.isFinite(n) ? n : null;
  }
  return str;
}

/** Render a stored value as display text. */
export function formatFieldValue(
  def: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
): string {
  if (value === null || value === undefined || value === '') return '';
  if (def.field_type === 'checkbox') return value ? 'Yes' : 'No';
  return String(value);
}
