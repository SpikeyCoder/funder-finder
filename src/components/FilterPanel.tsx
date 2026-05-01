import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X, ChevronDown, ChevronUp, Search } from 'lucide-react';

export interface FilterState {
  states: string[];
  ntee_codes: string[];
  funding_types: string[];
  funder_types: string[];
  grant_size_min: number | null;
  grant_size_max: number | null;
  keyword: string;
  gives_to_peers: boolean;
  locations_served: string[]; // continents, countries, or "Global"
}

export const EMPTY_FILTERS: FilterState = {
  states: [],
  ntee_codes: [],
  funding_types: [],
  funder_types: [],
  grant_size_min: null,
  grant_size_max: null,
  keyword: '',
  gives_to_peers: false,
  locations_served: [],
};

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
];

const NTEE_CATEGORIES = [
  { code: 'A', label: 'Arts, Culture & Humanities' },
  { code: 'B', label: 'Education' },
  { code: 'C', label: 'Environment & Animals' },
  { code: 'D', label: 'Animal Related' },
  { code: 'E', label: 'Health General' },
  { code: 'F', label: 'Mental Health, Crisis Intervention' },
  { code: 'G', label: 'Disease, Disorders, Medical Disciplines' },
  { code: 'H', label: 'Medical Research' },
  { code: 'I', label: 'Crime & Law Enforcement' },
  { code: 'J', label: 'Employment' },
  { code: 'K', label: 'Food, Agriculture & Nutrition' },
  { code: 'L', label: 'Housing & Shelter' },
  { code: 'M', label: 'Public Safety, Disaster Preparedness' },
  { code: 'N', label: 'Recreation & Sports' },
  { code: 'O', label: 'Youth Development' },
  { code: 'P', label: 'Human Services' },
  { code: 'Q', label: 'International, Foreign Affairs' },
  { code: 'R', label: 'Civil Rights, Social Action' },
  { code: 'S', label: 'Community Improvement & Development' },
  { code: 'T', label: 'Philanthropy & Voluntarism' },
  { code: 'U', label: 'Science & Technology' },
  { code: 'V', label: 'Social Sciences' },
  { code: 'W', label: 'Public, Societal Benefit' },
  { code: 'X', label: 'Religion Related' },
  { code: 'Y', label: 'Mutual Benefit' },
  { code: 'Z', label: 'Unknown' },
];

// Continents and commonly-funded countries/regions for international filtering.
// These map to terms that appear in funder descriptions or focus areas.
export const INTERNATIONAL_LOCATIONS: { group: string; items: string[] }[] = [
  {
    group: 'Global',
    items: ['Global', 'Worldwide', 'International'],
  },
  {
    group: 'Continents',
    items: [
      'Africa',
      'Asia',
      'Europe',
      'Latin America',
      'Middle East',
      'North America',
      'Oceania',
      'Caribbean',
    ],
  },
  {
    group: 'Countries',
    items: [
      'Brazil', 'Canada', 'China', 'Colombia', 'Ethiopia', 'Ghana',
      'India', 'Indonesia', 'Kenya', 'Mexico', 'Nigeria', 'Pakistan',
      'Philippines', 'Rwanda', 'South Africa', 'Tanzania', 'Uganda',
      'United Kingdom', 'Vietnam', 'Zimbabwe',
    ],
  },
];

const FUNDING_TYPES = [
  { id: 'general_operating', label: 'General Operating' },
  { id: 'project_program', label: 'Project/Program' },
  { id: 'capital', label: 'Capital' },
  { id: 'capacity_building', label: 'Capacity Building' },
];

const FUNDER_TYPES = [
  { id: 'private_foundation', label: 'Private Foundation' },
  { id: 'community_foundation', label: 'Community Foundation' },
  { id: 'corporate', label: 'Corporate' },
  { id: 'government', label: 'Government' },
  { id: 'daf', label: 'Donor Advised Fund' },
];

const GRANT_SIZE_PRESETS = [
  { label: 'Under $25K', min: null, max: 25000 },
  { label: '$25K - $100K', min: 25000, max: 100000 },
  { label: '$100K - $500K', min: 100000, max: 500000 },
  { label: '$500K+', min: 500000, max: null },
];

interface FilterPanelProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  showPeerToggle?: boolean;
}

const Accordion: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, isOpen, onToggle, children }) => (
  <div className="border-b border-[#30363d]">
    <button
      onClick={onToggle}
      aria-expanded={isOpen}
      className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#161b22] transition-colors"
    >
      <span className="font-medium text-white">{title}</span>
      {isOpen ? (
        <ChevronUp size={18} className="text-gray-400" />
      ) : (
        <ChevronDown size={18} className="text-gray-400" />
      )}
    </button>
    {isOpen && <div className="px-4 py-3 border-t border-[#30363d]">{children}</div>}
  </div>
);

const FilterPanel: React.FC<FilterPanelProps> = ({ filters, onChange, showPeerToggle = false }) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    location: true,
    internationalLocation: false,
    fieldOfWork: true,
    fundingType: true,
    funderType: true,
    grantSize: true,
  });

  const [stateSearchTerm, setStateSearchTerm] = useState('');
  const [intlSearchTerm, setIntlSearchTerm] = useState('');

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const filteredStates = useMemo(() => {
    return US_STATES.filter((state) =>
      state.toLowerCase().includes(stateSearchTerm.toLowerCase())
    );
  }, [stateSearchTerm]);

  const handleStateChange = (state: string, checked: boolean) => {
    onChange({
      ...filters,
      states: checked
        ? [...filters.states, state]
        : filters.states.filter((s) => s !== state),
    });
  };

  const handleNTEEChange = (code: string, checked: boolean) => {
    onChange({
      ...filters,
      ntee_codes: checked
        ? [...filters.ntee_codes, code]
        : filters.ntee_codes.filter((c) => c !== code),
    });
  };

  const handleFundingTypeChange = (type: string, checked: boolean) => {
    onChange({
      ...filters,
      funding_types: checked
        ? [...filters.funding_types, type]
        : filters.funding_types.filter((t) => t !== type),
    });
  };

  const handleFunderTypeChange = (type: string, checked: boolean) => {
    onChange({
      ...filters,
      funder_types: checked
        ? [...filters.funder_types, type]
        : filters.funder_types.filter((t) => t !== type),
    });
  };

  const handleGrantSizePreset = (min: number | null, max: number | null) => {
    onChange({
      ...filters,
      grant_size_min: min,
      grant_size_max: max,
    });
  };

  const handleLocationServedChange = (location: string, checked: boolean) => {
    onChange({
      ...filters,
      locations_served: checked
        ? [...filters.locations_served, location]
        : filters.locations_served.filter((l) => l !== location),
    });
  };

  const filteredIntlItems = useMemo(() => {
    if (!intlSearchTerm) return INTERNATIONAL_LOCATIONS;
    const term = intlSearchTerm.toLowerCase();
    return INTERNATIONAL_LOCATIONS.map((g) => ({
      ...g,
      items: g.items.filter((item) => item.toLowerCase().includes(term)),
    })).filter((g) => g.items.length > 0);
  }, [intlSearchTerm]);

  const handleClearAll = () => {
    onChange(EMPTY_FILTERS);
    setStateSearchTerm('');
    setIntlSearchTerm('');
  };

  const activeFilterCount = [
    ...filters.states,
    ...filters.ntee_codes,
    ...filters.funding_types,
    ...filters.funder_types,
    ...(filters.locations_served || []),
  ].length + (filters.grant_size_min !== null || filters.grant_size_max !== null ? 1 : 0) + (filters.keyword ? 1 : 0);

  const renderFilterChips = () => {
    const chips = [];

    filters.states.forEach((state) => {
      chips.push(
        <div key={`state-${state}`} className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {state}
          <button
            onClick={() => handleStateChange(state, false)}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    });

    filters.ntee_codes.forEach((code) => {
      const label = NTEE_CATEGORIES.find((cat) => cat.code === code)?.label || code;
      chips.push(
        <div key={`ntee-${code}`} className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {label}
          <button
            onClick={() => handleNTEEChange(code, false)}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    });

    filters.funding_types.forEach((type) => {
      const label = FUNDING_TYPES.find((t) => t.id === type)?.label || type;
      chips.push(
        <div key={`funding-${type}`} className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {label}
          <button
            onClick={() => handleFundingTypeChange(type, false)}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    });

    filters.funder_types.forEach((type) => {
      const label = FUNDER_TYPES.find((t) => t.id === type)?.label || type;
      chips.push(
        <div key={`funder-${type}`} className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {label}
          <button
            onClick={() => handleFunderTypeChange(type, false)}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    });

    (filters.locations_served || []).forEach((loc) => {
      chips.push(
        <div key={`loc-${loc}`} className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {loc}
          <button
            onClick={() => handleLocationServedChange(loc, false)}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    });

    if (filters.grant_size_min !== null || filters.grant_size_max !== null) {
      const minStr = filters.grant_size_min ? `$${(filters.grant_size_min / 1000).toFixed(0)}K` : '';
      const maxStr = filters.grant_size_max ? `$${(filters.grant_size_max / 1000).toFixed(0)}K` : '';
      const label = minStr && maxStr ? `${minStr} - ${maxStr}` : minStr || maxStr || 'Custom Range';
      chips.push(
        <div key="grant-size" className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {label}
          <button
            onClick={() => onChange({ ...filters, grant_size_min: null, grant_size_max: null })}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    }

    if (filters.keyword) {
      chips.push(
        <div key="keyword" className="inline-flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-gray-300">
          {filters.keyword}
          <button
            onClick={() => onChange({ ...filters, keyword: '' })}
            className="hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      );
    }

    return chips;
  };

  const panelContent = (
    <div className="flex flex-col h-full bg-[#161b22]">
      {/* Keyword Search */}
      <div className="p-4 border-b border-[#30363d]">
        <div className="relative">
          <Search size={18} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search keywords..."
            aria-label="Search keywords"
            value={filters.keyword}
            onChange={(e) => onChange({ ...filters, keyword: e.target.value })}
            className="w-full pl-10 pr-4 py-2 bg-[#0d1117] border border-[#30363d] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#58a6ff]"
          />
        </div>
      </div>

      {/* Active Filters Chips */}
      {activeFilterCount > 0 && (
        <div className="p-4 border-b border-[#30363d]">
          <div className="flex flex-wrap gap-2 mb-3">
            {renderFilterChips()}
          </div>
          <button
            onClick={handleClearAll}
            className="text-sm text-[#58a6ff] hover:underline"
          >
            Clear All Filters
          </button>
        </div>
      )}

      {/* Accordion Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Location */}
        <Accordion
          title={`Location ${filters.states.length > 0 ? `(${filters.states.length})` : ''}`}
          isOpen={expandedSections.location}
          onToggle={() => toggleSection('location')}
        >
          <div className="mb-3">
            <input
              type="text"
              placeholder="Search states..."
              aria-label="Search states"
              value={stateSearchTerm}
              onChange={(e) => setStateSearchTerm(e.target.value)}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#58a6ff] text-sm"
            />
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {filteredStates.map((state) => (
              <label key={state} className="flex items-center gap-2 cursor-pointer hover:text-gray-200">
                <input
                  type="checkbox"
                  checked={filters.states.includes(state)}
                  onChange={(e) => handleStateChange(state, e.target.checked)}
                  className="rounded border-[#30363d] accent-[#58a6ff]"
                />
                <span className="text-sm text-gray-300">{state}</span>
              </label>
            ))}
          </div>
        </Accordion>

        {/* International / Multi-Location */}
        <Accordion
          title={`International Locations ${(filters.locations_served || []).length > 0 ? `(${filters.locations_served.length})` : ''}`}
          isOpen={expandedSections.internationalLocation}
          onToggle={() => toggleSection('internationalLocation')}
        >
          <p className="text-xs text-gray-500 mb-2">Filter funders by the countries or regions they serve.</p>
          <div className="mb-3">
            <input
              type="text"
              placeholder="Search locations..."
              aria-label="Search international locations"
              value={intlSearchTerm}
              onChange={(e) => setIntlSearchTerm(e.target.value)}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#58a6ff] text-sm"
            />
          </div>
          <div className="space-y-3 max-h-56 overflow-y-auto">
            {filteredIntlItems.map((group) => (
              <div key={group.group}>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{group.group}</p>
                <div className="space-y-1.5">
                  {group.items.map((item) => (
                    <label key={item} className="flex items-center gap-2 cursor-pointer hover:text-gray-200">
                      <input
                        type="checkbox"
                        checked={(filters.locations_served || []).includes(item)}
                        onChange={(e) => handleLocationServedChange(item, e.target.checked)}
                        className="rounded border-[#30363d] accent-[#58a6ff]"
                      />
                      <span className="text-sm text-gray-300">{item}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Accordion>

        {/* Field of Work */}
        <Accordion
          title={`Field of Work ${filters.ntee_codes.length > 0 ? `(${filters.ntee_codes.length})` : ''}`}
          isOpen={expandedSections.fieldOfWork}
          onToggle={() => toggleSection('fieldOfWork')}
        >
          <div className="space-y-2">
            {NTEE_CATEGORIES.map((category) => (
              <label key={category.code} className="flex items-start gap-2 cursor-pointer hover:text-gray-200">
                <input
                  type="checkbox"
                  checked={filters.ntee_codes.includes(category.code)}
                  onChange={(e) => handleNTEEChange(category.code, e.target.checked)}
                  className="rounded border-[#30363d] accent-[#58a6ff] mt-0.5"
                />
                <span className="text-sm text-gray-300">{category.label}</span>
              </label>
            ))}
          </div>
        </Accordion>

        {/* Funding Type */}
        <Accordion
          title={`Funding Type ${filters.funding_types.length > 0 ? `(${filters.funding_types.length})` : ''}`}
          isOpen={expandedSections.fundingType}
          onToggle={() => toggleSection('fundingType')}
        >
          <div className="space-y-2">
            {FUNDING_TYPES.map((type) => (
              <label key={type.id} className="flex items-center gap-2 cursor-pointer hover:text-gray-200">
                <input
                  type="checkbox"
                  checked={filters.funding_types.includes(type.id)}
                  onChange={(e) => handleFundingTypeChange(type.id, e.target.checked)}
                  className="rounded border-[#30363d] accent-[#58a6ff]"
                />
                <span className="text-sm text-gray-300">{type.label}</span>
              </label>
            ))}
          </div>
        </Accordion>

        {/* Funder Type */}
        <Accordion
          title={`Funder Type ${filters.funder_types.length > 0 ? `(${filters.funder_types.length})` : ''}`}
          isOpen={expandedSections.funderType}
          onToggle={() => toggleSection('funderType')}
        >
          <div className="space-y-2">
            {FUNDER_TYPES.map((type) => (
              <label key={type.id} className="flex items-center gap-2 cursor-pointer hover:text-gray-200">
                <input
                  type="checkbox"
                  checked={filters.funder_types.includes(type.id)}
                  onChange={(e) => handleFunderTypeChange(type.id, e.target.checked)}
                  className="rounded border-[#30363d] accent-[#58a6ff]"
                />
                <span className="text-sm text-gray-300">{type.label}</span>
              </label>
            ))}
          </div>
        </Accordion>

        {/* Grant Size */}
        <Accordion
          title="Grant Size"
          isOpen={expandedSections.grantSize}
          onToggle={() => toggleSection('grantSize')}
        >
          <div className="space-y-3">
            {/* Presets */}
            <div className="space-y-2">
              {GRANT_SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => handleGrantSizePreset(preset.min, preset.max)}
                  className={`w-full px-3 py-2 text-sm rounded text-left transition-colors ${
                    filters.grant_size_min === preset.min && filters.grant_size_max === preset.max
                      ? 'bg-[#58a6ff] text-white'
                      : 'bg-[#0d1117] border border-[#30363d] text-gray-300 hover:border-[#58a6ff]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Custom Range */}
            <div className="pt-2 border-t border-[#30363d]">
              <label className="block text-sm text-gray-300 mb-2">Custom Range</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="Min"
                  aria-label="Minimum grant amount in dollars"
                  value={filters.grant_size_min ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      grant_size_min: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  className="flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#58a6ff] text-sm"
                />
                <input
                  type="number"
                  placeholder="Max"
                  aria-label="Maximum grant amount in dollars"
                  value={filters.grant_size_max ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      grant_size_max: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  className="flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#58a6ff] text-sm"
                />
              </div>
            </div>
          </div>
        </Accordion>

        {/* Gives to Peers Toggle */}
        {showPeerToggle && (
          <div className="p-4 border-b border-[#30363d]">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.gives_to_peers}
                onChange={(e) => onChange({ ...filters, gives_to_peers: e.target.checked })}
                className="rounded border-[#30363d] accent-[#58a6ff]"
              />
              <span className="text-sm text-gray-300">Only Gives to Peers</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <div className="hidden md:block w-80 bg-[#161b22] border-r border-[#30363d] sticky top-16 h-[calc(100vh-64px)] overflow-hidden flex flex-col">
        {panelContent}
      </div>

      {/* Mobile Bottom Sheet - rendered into document.body so an ancestor's
          CSS transform (e.g. page-fade-in) cannot break position: fixed. */}
      {createPortal(
        <div className="md:hidden fixed bottom-6 right-6 z-40">
          <FilterButton panelContent={panelContent} />
        </div>,
        document.body
      )}
    </>
  );
};

const FilterButton: React.FC<{ panelContent: React.ReactNode }> = ({ panelContent }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-[#58a6ff] text-white rounded-lg shadow-lg hover:bg-[#1f6feb] transition-colors"
      >
        <Filter size={20} />
        <span className="text-sm font-medium">Filters</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col">
          <div
            className="flex-1 bg-black bg-opacity-50"
            onClick={() => setIsOpen(false)}
          />
          <div className="bg-[#161b22] rounded-t-lg max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-[#30363d]">
              <h3 className="text-lg font-semibold text-white">Filters</h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-[#0d1117] rounded transition-colors"
              >
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {panelContent}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default FilterPanel;
