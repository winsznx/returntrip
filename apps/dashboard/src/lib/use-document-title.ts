import { useEffect } from 'react';

/** The tab title is outside React's tree, so it is synchronized as an external system. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === 'ReturnTrip' ? title : `${title} | ReturnTrip`;
  }, [title]);
}
