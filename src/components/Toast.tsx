import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface ToastProps {
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
  onClose: () => void;
}

export default function Toast({ message, action, duration = 5000, onClose }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300); // wait for exit animation
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-[#1f2937] border border-[#30363d] text-gray-200 px-4 py-3 rounded-xl shadow-lg transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      }`}
    >
      <span className="text-sm">{message}</span>
      {action && (
        <button
          onClick={action.onClick}
          className="text-sm font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap transition-colors"
        >
          {action.label}
        </button>
      )}
      <button onClick={() => { setVisible(false); setTimeout(onClose, 300); }} className="text-gray-500 hover:text-gray-300 ml-1">
        <X size={14} />
      </button>
    </div>
  );
}
