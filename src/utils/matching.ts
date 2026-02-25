import { Funder } from '../types';
import { funders } from '../data/funders';

export function findMatches(missionStatement: string, keywords: string[]): Funder[] {
  const text = (missionStatement + ' ' + keywords.join(' ')).toLowerCase();
  
  const scored = funders.map(funder => {
    let score = 0;
    const funderText = (funder.description + ' ' + funder.focusAreas.join(' ')).toLowerCase();
    
    // Score based on focus area keyword matches
    funder.focusAreas.forEach(area => {
      if (text.includes(area.toLowerCase())) score += 3;
    });
    
    // Score based on user keywords
    keywords.forEach(kw => {
      if (funderText.includes(kw.toLowerCase())) score += 2;
    });
    
    // Score based on common words in mission statement
    const words = text.split(/\s+/).filter(w => w.length > 4);
    words.forEach(word => {
      if (funderText.includes(word)) score += 0.5;
    });
    
    return { funder, score };
  });
  
  return scored
    .sort((a, b) => b.score - a.score)
    .map(s => s.funder);
}

export function getMatchingTags(funder: Funder, keywords: string[], missionStatement: string): string[] {
  const text = (missionStatement + ' ' + keywords.join(' ')).toLowerCase();
  return funder.focusAreas.filter(area => text.includes(area.toLowerCase()));
}
