import {
  Droplet,
  BookOpen,
  Moon,
  Leaf,
  Flame,
  Sun,
  Dumbbell,
  Footprints,
  PenLine,
  Music,
  Heart,
  Brain,
  Coffee,
  Bed,
  Utensils,
  Wind,
  Sparkles,
} from 'lucide-react';

export const ICON_OPTIONS = [
  { id: 'droplet', Icon: Droplet, label: 'Water' },
  { id: 'book', Icon: BookOpen, label: 'Reading' },
  { id: 'moon', Icon: Moon, label: 'Sleep' },
  { id: 'leaf', Icon: Leaf, label: 'Stretch' },
  { id: 'flame', Icon: Flame, label: 'Cardio' },
  { id: 'sun', Icon: Sun, label: 'Morning' },
  { id: 'dumbbell', Icon: Dumbbell, label: 'Exercise' },
  { id: 'footprints', Icon: Footprints, label: 'Walk' },
  { id: 'pen', Icon: PenLine, label: 'Journal' },
  { id: 'music', Icon: Music, label: 'Music' },
  { id: 'heart', Icon: Heart, label: 'Health' },
  { id: 'brain', Icon: Brain, label: 'Meditate' },
  { id: 'coffee', Icon: Coffee, label: 'Coffee' },
  { id: 'bed', Icon: Bed, label: 'Rest' },
  { id: 'food', Icon: Utensils, label: 'Nutrition' },
  { id: 'wind', Icon: Wind, label: 'Breathing' },
  { id: 'sparkles', Icon: Sparkles, label: 'General' },
];

const ICON_BY_ID = Object.fromEntries(ICON_OPTIONS.map((o) => [o.id, o.Icon]));

const KEYWORD_RULES = [
  { id: 'droplet', words: ['water', 'drink', 'hydrate'] },
  { id: 'book', words: ['read', 'book', 'study'] },
  { id: 'moon', words: ['sleep', 'bed', 'nap'] },
  { id: 'brain', words: ['meditat', 'mindful', 'calm'] },
  { id: 'leaf', words: ['stretch', 'yoga'] },
  { id: 'dumbbell', words: ['gym', 'workout', 'lift', 'exercise'] },
  { id: 'flame', words: ['run', 'cardio', 'jog'] },
  { id: 'footprints', words: ['walk', 'steps'] },
  { id: 'pen', words: ['journal', 'write', 'diary'] },
  { id: 'music', words: ['music', 'practice', 'instrument', 'guitar', 'piano'] },
  { id: 'coffee', words: ['coffee', 'tea'] },
  { id: 'food', words: ['eat', 'meal', 'lunch', 'dinner', 'breakfast', 'diet'] },
  { id: 'wind', words: ['breath'] },
  { id: 'heart', words: ['health', 'vitamin', 'medicine', 'pill'] },
  { id: 'sun', words: ['morning', 'wake'] },
];

export function suggestIconId(title) {
  const lower = (title || '').toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.words.some((w) => lower.includes(w))) return rule.id;
  }
  return 'sparkles';
}

export function getRoutineIcon(routine) {
  const id = routine.icon || suggestIconId(routine.title);
  return ICON_BY_ID[id] || Sparkles;
}
