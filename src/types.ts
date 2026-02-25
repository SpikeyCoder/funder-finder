export interface Funder {
  id: string;
  name: string;
  type: 'Foundation' | 'Community Foundation' | 'DAF' | 'Corporate Giving' | 'Government Grant' | 'Family Foundation';
  description: string;
  focusAreas: string[];
  contact: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  website: string;
  nextStep: string;
  grantRange?: string;
}
