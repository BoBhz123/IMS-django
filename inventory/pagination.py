from rest_framework.pagination import PageNumberPagination


class DefaultPagination(PageNumberPagination):
    page_size = 10
    # Lets a caller that only needs a handful of rows say so (the dashboard's "recent orders"
    # panel asks for ?page_size=8) instead of pulling a full page it throws away. Capped so a
    # client can't ask for the whole table back and undo the point of paginating.
    page_size_query_param = 'page_size'
    max_page_size = 100
