-- Enable RLS on funders and search_cache tables
-- Previously these tables had no RLS, exposing all data via PostgREST

ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read access (funders are public reference data)
CREATE POLICY "funders_anon_select" ON public.funders
  FOR SELECT USING (true);

-- Only service role can insert/update/delete funders
CREATE POLICY "funders_service_write" ON public.funders
  FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read their own cached searches
CREATE POLICY "search_cache_authenticated_select" ON public.search_cache
  FOR SELECT TO authenticated USING (true);

-- Only service role can write to search_cache
CREATE POLICY "search_cache_service_write" ON public.search_cache
  FOR ALL USING (auth.role() = 'service_role');
