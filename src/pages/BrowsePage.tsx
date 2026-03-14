import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink, ArrowUpDown } from 'lucide-react';
import NavBar from '../components/NavBar';
import FilterPanel, { FilterState, EMPTY_FILTERS } from '../components/FilterPanel';
import SaveToProjectButton from '../components/SaveToProjectButton';
import { supabase, getEdgeFunctionHeaders, SUPABASE_ANON_KEY } from '../lib/supabase';

const EDGE_FUNCTION_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/filter-funders';

interface FunderResult {
  ein: string;
  funder_id: string;
  name: string;
  state: string;
  entity_type: string;
  ntee_code: string;
  avg_grant_size: number | null;
  total_giving: number | null;
  grant_count: number | null;
}

interface FilterResponse {
  results: FunderResult[];
  total: number;
  page: number;
  per_page: number;
}

type SortField = 'name' | 'state' | 'entity_type' | 'avg_grant_size' | 'total_giving' | 'grant_count';
type SortOrder = 'asc' | 'desc';

const BrowsePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [results, setResults] = useState<FunderResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const RESULTS_PER_PAGE = 25;

  // Parse URL params on mount and when they change
  useEffect(() => {
    const parsedFilters = parseUrlParams(searchParams);
    setFilters(parsedFilters);
    setCurrentPage(1);
  }, [searchParams]);

  // Debounced filter application
  const debouncedFetch = useMemo(() => {
    let timeoutId: NodeJS.Timeout;

    return (newFilters: FilterState, page: number) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        fetchFunders(newFilters, page);
      }, 300);
    };
  }, []);

  useEffect(() => {
    debouncedFetch(filters, currentPage);
  }, [filters, currentPage, sortField, sortOrder, debouncedFetch]);

  const parseUrlParams = (params: URLSearchParams): FilterState => {
    const states = params.get('states')?.split(',').filter(Boolean) || [];
    const ntee = params.get('ntee')?.split(',').filter(Boolean) || [];
    const fundingTypes = params.get('funding_types')?.split(',').filter(Boolean) || [];
    const funderTypes = params.get('funder_types')?.split(',').filter(Boolean) || [];
    const minGrant = params.get('min_grant') ? parseInt(params.get('min_grant')!) : null;
    const maxGrant = params.get('max_grant') ? parseInt(params.get('max_grant')!) : null;
    const keyword = params.get('keyword') || '';
    const givesToPeers = params.get('gives_to_peers') === 'true';

    return {
      states,
      ntee_codes: ntee,
      funding_types: fundingTypes,
      funder_types: funderTypes,
      grant_size_min: minGrant,
      grant_size_max: maxGrant,
      keyword,
      gives_to_peers: givesToPeers,
    };
  };

  const updateUrlParams = (newFilters: FilterState) => {
    const params = new URLSearchParams();

    if (newFilters.states.length > 0) {
      params.set('states', newFilters.states.join(','));
    }
    if (newFilters.ntee_codes.length > 0) {
      params.set('ntee', newFilters.ntee_codes.join(','));
    }
    if (newFilters.funding_types.length > 0) {
      params.set('funding_types', newFilters.funding_types.join(','));
    }
    if (newFilters.funder_types.length > 0) {
      params.set('funder_types', newFilters.funder_types.join(','));
    }
    if (newFilters.grant_size_min !== null) {
      params.set('min_grant', newFilters.grant_size_min.toString());
    }
    if (newFilters.grant_size_max !== null) {
      params.set('max_grant', newFilters.grant_size_max.toString());
    }
    if (newFilters.keyword) {
      params.set('keyword', newFilters.keyword);
    }
    if (newFilters.gives_to_peers) {
      params.set('gives_to_peers', 'true');
    }

    setSearchParams(params, { replace: true });
  };

  const fetchFunders = async (newFilters: FilterState, page: number) => {
    setLoading(true);
    setError(null);

    try {
      const requestBody = {
        query: newFilters.keyword,
        filters: {
          states: newFilters.states,
          ntee_codes: newFilters.ntee_codes,
          funding_types: newFilters.funding_types,
          funder_types: newFilters.funder_types,
          grant_size_min: newFilters.grant_size_min,
          grant_size_max: newFilters.grant_size_max,
          gives_to_peers: newFilters.gives_to_peers,
        },
        sort_by: sortField,
        sort_order: sortOrder,
        page,
        per_page: RESULTS_PER_PAGE,
      };

      const response = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getEdgeFunctionHeaders(),
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data: FilterResponse = await response.json();
      setResults(data.results || []);
      setTotalCount(data.total ?? 0);
    } catch (err) {
      console.error('Error fetching funders:', err);
      setError(err instanceof Error ? err.message : 'Failed to load funders');
      setResults([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (newFilters: FilterState) => {
    setFilters(newFilters);
    updateUrlParams(newFilters);
    setCurrentPage(1);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);
  const startIndex = (currentPage - 1) * RESULTS_PER_PAGE + 1;
  const endIndex = Math.min(currentPage * RESULTS_PER_PAGE, totalCount);

  const SortHeader: React.FC<{ field: SortField; label: string }> = ({ field, label }) => (
    <button
      onClick={() => handleSort(field)}
      className="inline-flex items-center gap-2 hover:text-gray-300 transition-colors font-medium"
    >
      {label}
      {sortField === field && (
        <ArrowUpDown
          size={14}
          className={`transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`}
        />
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-[#0d1117]">
      <NavBar />

      <div className="flex h-[calc(100vh-64px)]">
        {/* Filter Panel - Desktop Sidebar */}
        <FilterPanel filters={filters} onChange={handleFilterChange} />

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Results Header */}
          <div className="border-b border-[#30363d] p-4 bg-[#161b22]">
            {totalCount > 0 ? (
              <div className="text-sm text-gray-400">
                Showing <span className="text-white font-medium">{startIndex}</span> to{' '}
                <span className="text-white font-medium">{endIndex}</span> of{' '}
                <span className="text-white font-medium">{totalCount}</span> funders
              </div>
            ) : loading ? (
              <div className="text-sm text-gray-400">Loading...</div>
            ) : error ? (
              <div className="text-sm text-red-400">{error}</div>
            ) : (
              <div className="text-sm text-gray-400">No funders found. Try adjusting your filters.</div>
            )}
          </div>

          {/* Results Table */}
          <div className="flex-1 overflow-auto">
            {results.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#161b22] border-b border-[#30363d]">
                  <tr>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="name" label="Funder Name" />
                    </th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="state" label="State" />
                    </th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="entity_type" label="Type" />
                    </th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="avg_grant_size" label="Avg Grant Size" />
                    </th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="total_giving" label="Total Giving" />
                    </th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">
                      <SortHeader field="grant_count" label="Grants" />
                    </th>
                    <th className="px-4 py-3 text-center text-gray-400 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((funder, idx) => (
                    <tr
                      key={`${funder.ein}-${idx}`}
                      className="border-b border-[#30363d] hover:bg-[#161b22] transition-colors"
                    >
                      <td className="px-4 py-3 text-white">
                        <a
                          href={`/funder/${funder.ein}`}
                          className="text-[#58a6ff] hover:underline flex items-center gap-2"
                        >
                          {funder.name}
                          <ExternalLink size={14} className="opacity-50" />
                        </a>
                      </td>
                      <td className="px-4 py-3 text-gray-300">{funder.state || '-'}</td>
                      <td className="px-4 py-3 text-gray-300">{funder.entity_type || '-'}</td>
                      <td className="px-4 py-3 text-gray-300">
                        {funder.avg_grant_size
                          ? `$${(funder.avg_grant_size / 1000).toFixed(0)}K`
                          : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {funder.total_giving
                          ? `$${(funder.total_giving / 1000000).toFixed(1)}M`
                          : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {funder.grant_count || '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <SaveToProjectButton
                          funderEin={funder.ein}
                          funderName={funder.name}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                {loading ? (
                  <div className="text-center">
                    <div className="text-lg font-medium mb-2">Loading funders...</div>
                    <div className="text-sm">Please wait</div>
                  </div>
                ) : error ? (
                  <div className="text-center">
                    <div className="text-lg font-medium mb-2 text-red-400">Error</div>
                    <div className="text-sm">{error}</div>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="text-lg font-medium mb-2">No funders found</div>
                    <div className="text-sm">Try adjusting your filters</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="border-t border-[#30363d] p-4 bg-[#161b22] flex items-center justify-center gap-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1 || loading}
                className="px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-gray-300 hover:border-[#58a6ff] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>

              <div className="flex gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }

                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      disabled={loading}
                      className={`px-3 py-2 rounded transition-colors ${
                        currentPage === pageNum
                          ? 'bg-[#58a6ff] text-white'
                          : 'bg-[#0d1117] border border-[#30363d] text-gray-300 hover:border-[#58a6ff] hover:text-white disabled:opacity-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages || loading}
                className="px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded text-gray-300 hover:border-[#58a6ff] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BrowsePage;
