'use client';
import { Component, type ReactNode } from 'react';
/** Optional attachment code must never take down its parent request or audit. */
export class FleetAttachmentBoundary extends Component<{children:ReactNode;fallback:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
