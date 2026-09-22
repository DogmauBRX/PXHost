import { apiFetch } from '@/shared/api/client';

export interface CommunityUser {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
}

export interface UserSearchResult extends CommunityUser {
  friendship: { id: string; status: 'pending' | 'accepted'; direction: 'incoming' | 'outgoing' } | null;
}

export interface FriendshipItem {
  id: string;
  status: 'pending' | 'accepted';
  direction: 'incoming' | 'outgoing';
  user: CommunityUser;
  createdAt: string;
}

export interface Friendships {
  accepted: FriendshipItem[];
  incoming: FriendshipItem[];
  outgoing: FriendshipItem[];
}

export interface CommunityServer {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  description: string;
  address: string;
  software: string | null;
  version: string | null;
  publishedAt: string;
  owner: CommunityUser;
  isFriend: boolean;
  isOwner: boolean;
}

export interface CommunityServerDetails extends CommunityServer {
  modpack: {
    source: string;
    projectId: string;
    projectName: string;
    versionName: string;
    minecraftVersion: string;
    loader: string;
    completedAt: string | null;
  } | null;
}

export interface PublishableServer {
  id: string;
  name: string;
  status: string;
  publicAddress: string | null;
  published: boolean;
  description: string;
}

export const searchCommunityUsers = (q: string) => apiFetch<UserSearchResult[]>(`/api/client/community/users?q=${encodeURIComponent(q)}`);
export const getFriends = () => apiFetch<Friendships>('/api/client/community/friends');
export const requestFriend = (userId: string) => apiFetch(`/api/client/community/friends/${userId}`, { method: 'POST' });
export const acceptFriend = (friendshipId: string) => apiFetch(`/api/client/community/friends/${friendshipId}/accept`, { method: 'POST' });
export const removeFriend = (friendshipId: string) => apiFetch(`/api/client/community/friends/${friendshipId}`, { method: 'DELETE' });
export const getCommunityServers = () => apiFetch<CommunityServer[]>('/api/client/community/servers');
export const getCommunityServerDetails = (listingId: string) => apiFetch<CommunityServerDetails>(`/api/client/community/servers/${listingId}/details`);
export const downloadCommunityClientFiles = (listingId: string) => apiFetch<{ url: string; filename: string; expiresIn: number }>(`/api/client/community/servers/${listingId}/download`, { method: 'POST' });
export const getPublishableServers = () => apiFetch<PublishableServer[]>('/api/client/community/my-servers');
export const publishServer = (serverId: string, description: string) => apiFetch(`/api/client/community/servers/${serverId}`, { method: 'PUT', body: JSON.stringify({ description }) });
export const unpublishServer = (serverId: string) => apiFetch(`/api/client/community/servers/${serverId}`, { method: 'DELETE' });
