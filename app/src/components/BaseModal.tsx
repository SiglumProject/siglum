import React, { useState, useEffect, useCallback } from 'react';
import './BaseModal.css';

interface BaseModalProps {
  isOpen: boolean;
  isClosing?: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
  overlayClassName?: string;
  headerContent?: React.ReactNode; // Custom content to place before the title
  hideHeader?: boolean; // Hide the default header
}

const BaseModal: React.FC<BaseModalProps> = ({
  isOpen,
  isClosing = false,
  onClose,
  title,
  children,
  maxWidth = '800px',
  className = '',
  overlayClassName = '',
  headerContent,
  hideHeader = false
}) => {
  const [internalClosing, setInternalClosing] = useState(false);

  // Handle close with animation
  const handleClose = useCallback(() => {
    setInternalClosing(true);
    setTimeout(() => {
      setInternalClosing(false);
      onClose();
    }, 200); // Match CSS animation duration
  }, [onClose]);

  // Reset when opening
  useEffect(() => {
    if (isOpen) {
      setInternalClosing(false);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const isCurrentlyClosing = isClosing || internalClosing;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div 
      className={`base-modal-overlay ${overlayClassName} ${isCurrentlyClosing ? 'closing' : ''}`} 
      onClick={handleOverlayClick}
    >
      <div 
        className={`base-modal ${className}`}
        style={{ maxWidth }}
      >
        {!hideHeader && (
          <div className="base-modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {headerContent}
              <h2>{title}</h2>
            </div>
            <button className="base-modal-close-button" onClick={handleClose}>
              ✕
            </button>
          </div>
        )}
        <div className="base-modal-content">
          {children}
        </div>
      </div>
    </div>
  );
};

export default BaseModal;