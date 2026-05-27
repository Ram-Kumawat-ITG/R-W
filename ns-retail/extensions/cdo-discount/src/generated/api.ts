export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  JSON: { input: any; output: any; }
};

export type Attribute = {
  __typename?: 'Attribute';
  value?: Maybe<Scalars['String']['output']>;
};

export type Cart = {
  __typename?: 'Cart';
  attribute?: Maybe<Attribute>;
};


export type CartAttributeArgs = {
  key: Scalars['String']['input'];
};

export type Discount = {
  __typename?: 'Discount';
  metafield?: Maybe<Metafield>;
};


export type DiscountMetafieldArgs = {
  key: Scalars['String']['input'];
  namespace: Scalars['String']['input'];
};

export type Metafield = {
  __typename?: 'Metafield';
  jsonValue?: Maybe<Scalars['JSON']['output']>;
  value?: Maybe<Scalars['String']['output']>;
};

export type Query = {
  __typename?: 'Query';
  cart: Cart;
  discount?: Maybe<Discount>;
};

export type InputQueryVariables = Exact<{ [key: string]: never; }>;


export type InputQuery = { __typename?: 'Query', cart: { __typename?: 'Cart', cdoRef?: { __typename?: 'Attribute', value?: string | null } | null }, discount?: { __typename?: 'Discount', metafield?: { __typename?: 'Metafield', jsonValue?: any | null } | null } | null };
