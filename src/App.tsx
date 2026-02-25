import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import MissionInput from './pages/MissionInput';
import Results from './pages/Results';
import FunderDetail from './pages/FunderDetail';
import SavedFunders from './pages/SavedFunders';
import NotFound from './pages/NotFound';

function App() {
  return (
    <BrowserRouter basename="/funder-finder">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/mission" element={<MissionInput />} />
        <Route path="/results" element={<Results />} />
        <Route path="/funder/:id" element={<FunderDetail />} />
        <Route path="/saved" element={<SavedFunders />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
