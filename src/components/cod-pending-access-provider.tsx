"use client";

import {createContext,useContext,type ReactNode} from 'react';

const CodPendingAccess=createContext(false);
export function CodPendingAccessProvider({allowed,children}:{allowed:boolean;children:ReactNode}) {
  return <CodPendingAccess.Provider value={allowed}>{children}</CodPendingAccess.Provider>;
}
export function useCodPendingAccess(){return useContext(CodPendingAccess);}
